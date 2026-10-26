import { setTimeout as sleep } from "node:timers/promises";
import { createCanvas } from "@napi-rs/canvas";
import {
  ATLAS_HEIGHT,
  ATLAS_WIDTH,
  createGarden,
  type Garden,
  type Image,
  paintLeafAtlas,
  type Season,
  type Species,
} from "@opengardenjs/core";
import { create, globals } from "webgpu";
import { type Capturer, createCapturer } from "./capture.ts";
import { type ControlAction, createControls } from "./controls.ts";
import { createKittyScreen } from "./kitty.ts";
import {
  type MouseAction,
  openTerminal,
  screenScale,
  type TerminalSize,
  write,
} from "./terminal.ts";

const ESC = "\x1b";
const FORMAT = "rgba8unorm";
const MAX_STEP_SECONDS = 0.1;
const FENCE_TIMEOUT_MS = 500;
const FENCE_ID = 3;
const SEASON_KEYS: Record<string, Season> = {
  "1": "spring",
  "2": "summer",
  "3": "autumn",
  "4": "winter",
};
const QUIT_KEYS = new Set(["q", "\x03", "\x04"]);
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface TerminalOptions {
  species: Species;
  seed?: number;
  season?: Season;
  /** Shows the hint and the season and new tree buttons. Defaults to false. */
  controls?: boolean;
  /** Rendered pixels per screen pixel, above 0 and at most 2. Defaults to 1. */
  pixelRatio?: number;
  /** Frames per second, a whole number from 1 to 120. Defaults to 60. */
  fps?: number;
  /** Receives a line for each event, and a line of frame stats each second. */
  log?: (line: string) => void;
}

let dawn: GPU | undefined;

/** Dawn's equivalent of `navigator.gpu`. */
export function dawnGpu(): GPU {
  if (!dawn) {
    Object.assign(globalThis, globals);
    // dawn.node crashes if this object is garbage collected while its device lives.
    dawn = create([]);
  }
  return dawn;
}

/** Paints the leaf atlas with the Canvas 2D API of `@napi-rs/canvas`. */
export function paintAtlas(): Image {
  const ctx = createCanvas(ATLAS_WIDTH, ATLAS_HEIGHT).getContext("2d");
  paintLeafAtlas(ctx);
  const { data } = ctx.getImageData(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);
  return {
    width: ATLAS_WIDTH,
    height: ATLAS_HEIGHT,
    data: new Uint8Array(data),
  };
}

/**
 * Shows the garden full screen in a terminal that supports the Kitty graphics
 * protocol, until the user quits or a signal arrives. Resolves after the
 * terminal is restored.
 */
export function runInTerminal(options: TerminalOptions): Promise<void> {
  const pixelRatio = options.pixelRatio ?? 1;
  if (!(pixelRatio > 0 && pixelRatio <= 2))
    throw new Error("pixelRatio must be above 0 and at most 2");
  const fps = options.fps ?? 60;
  if (!(Number.isInteger(fps) && fps >= 1 && fps <= 120))
    throw new Error("fps must be a whole number from 1 to 120");
  const log = options.log ?? (() => {});

  return new Promise((resolve, reject) => {
    const screen = createKittyScreen();
    const controls = options.controls
      ? createControls(options.season ?? "spring")
      : undefined;

    let size: TerminalSize | undefined;
    let resized = false;
    let scale = 1;
    let device: GPUDevice | undefined;
    let garden: Garden | undefined;
    let closing = false;

    let fenceReached: (() => void) | undefined;

    const writeAndAwaitReply = (sequence: string) =>
      new Promise<boolean>((done) => {
        const timer = setTimeout(() => {
          fenceReached = undefined;
          done(false);
        }, FENCE_TIMEOUT_MS);
        fenceReached = () => {
          clearTimeout(timer);
          fenceReached = undefined;
          done(true);
        };
        write(
          `${ESC}[?2026h${sequence}${ESC}[?2026l${ESC}_Ga=q,i=${FENCE_ID},s=1,v=1,f=24,t=d;AAAA${ESC}\\`,
        );
      });

    const onGraphics = (reply: string) => {
      if (reply.startsWith(`i=${FENCE_ID};`)) {
        fenceReached?.();
        return;
      }
      log(`graphics: ${reply}`);
      redraw = true;
    };

    let overlayDirty = true;
    let cursor = "";
    let pressedOn: "garden" | "controls" | undefined;

    const setCursor = (shape: string) => {
      if (shape === cursor) return;
      cursor = shape;
      write(`${ESC}]22;${shape}${ESC}\\`);
    };

    const setSeason = (season: Season) => {
      garden?.setSeason(season);
      controls?.select(season);
      overlayDirty = true;
    };

    const onControl = (action: ControlAction | undefined) => {
      if (action?.type === "season") setSeason(action.season);
      else if (action?.type === "new-tree") garden?.newTree();
    };

    const onMouse = (
      action: MouseAction,
      _button: number,
      px: number,
      py: number,
    ) => {
      if (!garden) return;
      const x = px / scale;
      const y = py / scale;
      const target =
        pressedOn ?? (controls?.over(x, y) ? "controls" : "garden");
      if (controls && target === "controls") {
        if (action === "press") {
          pressedOn = "controls";
          overlayDirty ||= controls.press(x, y);
        } else if (action === "release") {
          pressedOn = undefined;
          onControl(controls.release(x, y));
          overlayDirty = true;
        }
        overlayDirty ||= controls.hover(x, y);
        setCursor(controls.over(x, y) ? "pointer" : "default");
        return;
      }
      overlayDirty ||= controls?.hover(-1, -1) ?? false;
      if (action === "press") {
        pressedOn = "garden";
        garden.pointerDown(x, y, false);
      } else if (action === "release") {
        pressedOn = undefined;
        garden.pointerUp(x, y, false);
      } else garden.pointerMove(x, y);
      setCursor(garden.overLeaves ? "pointer" : "default");
    };

    const onKey = (key: string) => {
      if (QUIT_KEYS.has(key)) shutdown();
      else if (key in SEASON_KEYS) setSeason(SEASON_KEYS[key]);
      else if (key === "n") garden?.newTree();
    };

    const onSize = (next: TerminalSize) => {
      if (
        size?.columns === next.columns &&
        size.rows === next.rows &&
        size.cellWidth === next.cellWidth &&
        size.cellHeight === next.cellHeight
      )
        return;
      size = next;
      resized = true;
    };

    let sized = false;
    let redraw = true;
    let background = "";

    const applySize = (
      capturer: Capturer,
      view: Garden,
      next: TerminalSize,
    ) => {
      scale = screenScale(next);
      const { width, height } = screen.layout(next, pixelRatio / scale);
      log(
        `size ${next.columns}×${next.rows} cells of ${next.cellWidth}×${next.cellHeight}px, rendering ${width}×${height}px`,
      );
      capturer.resize(width, height);
      view.resize(width, height, pixelRatio);
      controls?.layout(
        (next.columns * next.cellWidth) / scale,
        (next.rows * next.cellHeight) / scale,
      );
      sized = true;
      redraw = true;
    };

    const stats = {
      shown: 0,
      bytes: 0,
      edits: 0,
      renderMs: 0,
      terminalMs: 0,
    };

    const showFrame = async (capturer: Capturer) => {
      const started = performance.now();
      const full = redraw;
      redraw = false;
      const capture = await capturer.read();
      if (closing) {
        capture.release();
        return;
      }
      const frame = screen.present(capture, full);
      const hex = (i: number) => capture.rgb[i].toString(16).padStart(2, "0");
      const color = `rgb:${hex(0)}/${hex(1)}/${hex(2)}`;
      capture.release();
      const rendered = performance.now();

      let sequence = full ? `${screen.clear()}${ESC}[2J` : "";
      if (color !== background) {
        background = color;
        sequence += `${ESC}]11;${color}${ESC}\\`;
      }
      sequence += frame.sequence;
      if (controls && (overlayDirty || full)) {
        overlayDirty = false;
        const overlay = controls.paint(scale);
        sequence += screen.overlay(
          overlay.png,
          overlay.x * scale,
          overlay.y * scale,
        );
      }
      if (!sequence) return;
      if (!(await writeAndAwaitReply(sequence))) {
        log("the terminal missed a frame, redrawing");
        redraw = true;
        return;
      }
      stats.shown++;
      stats.bytes += frame.bytes;
      stats.edits += frame.edits;
      stats.renderMs += rendered - started;
      stats.terminalMs += performance.now() - rendered;
    };

    const run = async (capturer: Capturer, view: Garden) => {
      const interval = 1000 / fps;
      let due = performance.now();
      let simulated = due;
      while (!closing) {
        if (resized && size) {
          resized = false;
          applySize(capturer, view, size);
        }
        view.advance(Math.min(MAX_STEP_SECONDS, (due - simulated) / 1000));
        simulated = due;
        if (sized) {
          capturer.render();
          await showFrame(capturer);
        }
        // A loop that sleeps a fixed time after each frame drifts to 58 fps, and then Rex freezes for up to 270 ms about once a second.
        due = Math.max(due + interval, performance.now());
        await sleep(Math.max(0, due - performance.now()));
      }
    };

    const closeTerminal = openTerminal({
      size: onSize,
      mouse: onMouse,
      key: onKey,
      graphics: onGraphics,
    });
    let statsTimer: NodeJS.Timeout | undefined;
    let running: Promise<void> | undefined;

    async function shutdown(error?: unknown) {
      if (closing) return;
      closing = true;
      clearInterval(statsTimer);
      await running?.catch(() => {});
      try {
        write(screen.clear());
      } catch {}
      await closeTerminal();
      for (const signal of SIGNALS) process.off(signal, onSignal);
      garden?.dispose();
      device?.destroy();
      screen.dispose();
      if (error) reject(error);
      else resolve();
    }

    const onSignal = () => shutdown();
    for (const signal of SIGNALS) process.on(signal, onSignal);

    const showLoading = () => {
      const text = "planting a tree…";
      const row = Math.max(1, Math.floor(process.stdout.rows / 2));
      const column = Math.max(
        1,
        Math.floor((process.stdout.columns - text.length) / 2),
      );
      write(`${ESC}[2J${ESC}[${row};${column}H${ESC}[2m${text}${ESC}[0m`);
    };

    const start = async () => {
      showLoading();
      const adapter = await dawnGpu().requestAdapter({
        powerPreference: "high-performance",
      });
      if (!adapter) throw new Error("WebGPU found no GPU adapter");
      const gpu = await adapter.requestDevice();
      device = gpu;
      void gpu.lost.then((info) => {
        if (!closing)
          shutdown(new Error(`the GPU device was lost: ${info.message}`));
      });
      gpu.addEventListener("uncapturederror", (event) =>
        log(`gpu: ${(event as GPUUncapturedErrorEvent).error.message}`),
      );
      const view = createGarden(gpu, FORMAT, {
        species: options.species,
        seed: options.seed,
        season: options.season,
        atlas: paintAtlas(),
      });
      garden = view;

      statsTimer = setInterval(() => {
        const per = (total: number) =>
          (total / Math.max(1, stats.shown)).toFixed(1);
        log(
          `fps ${stats.shown} kB/frame ${per(stats.bytes / 1000)} edits/frame ${per(stats.edits)} render ${per(stats.renderMs)}ms terminal ${per(stats.terminalMs)}ms`,
        );
        Object.assign(stats, {
          shown: 0,
          bytes: 0,
          edits: 0,
          renderMs: 0,
          terminalMs: 0,
        });
      }, 1000);

      running = run(createCapturer(gpu, view, FORMAT), view);
      await running;
    };

    start().catch(shutdown);
  });
}
