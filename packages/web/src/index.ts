import {
  ATLAS_HEIGHT,
  ATLAS_WIDTH,
  type Colors,
  type Garden,
  type GardenOptions,
  paintLeafAtlas,
  type Quality,
  type Season,
  type Species,
} from "@opengardenjs/core";
import { addStyle, createControls } from "./controls.ts";

export type RendererName = "webgpu" | "webgl";

export interface MountOptions extends Colors {
  species: Species;
  seed?: number;
  season?: Season;
  /** Shows the hint and the season and new tree buttons. Defaults to false. */
  controls?: boolean;
  /** Moves the tree right by this share of the canvas width. Negative moves it left. Defaults to 0. */
  offsetX?: number;
  /**
   * The GPU API to draw with. `auto` takes WebGPU if the browser has it, and
   * WebGL2 if not. Defaults to `auto`.
   */
  renderer?: "auto" | RendererName;
  /** Trades looks for speed on slow GPUs. Defaults to full quality. */
  quality?: Quality;
  /** Draws at this share of the screen resolution, and scales the image up. Defaults to 1. */
  renderScale?: number;
  /** Draws at most this many frames per second. Defaults to the display rate. */
  maxFps?: number;
}

/** A garden that runs in a canvas inside the host element. */
export interface MountedGarden {
  /** The GPU API that draws the garden. */
  readonly renderer: RendererName;
  setSeason(season: Season): void;
  /** Replaces the colors from the options, with the same wipe as a season change. */
  setColors(colors: Colors): void;
  /** Moves the tree right by this share of the canvas width. Negative moves it left. */
  setOffsetX(share: number): void;
  /** Blows the tree away and grows a new one from `seed`, or from a random seed. */
  newTree(seed?: number): void;
  /** Stops the garden and removes its canvas and buttons. */
  dispose(): void;
  /** Controls for tests and screenshots. Positions are shares of the canvas size, from 0 to 1. */
  debug: {
    reset(): void;
    freeze(frozen: boolean): void;
    step(seconds: number): void;
    touch(x: number, y: number, dx: number, dy: number): void;
    click(x: number, y: number): void;
  };
}

function paintAtlas() {
  const canvas = new OffscreenCanvas(ATLAS_WIDTH, ATLAS_HEIGHT);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");
  paintLeafAtlas(ctx);
  return ctx.getImageData(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);
}

async function webgpuAdapter(required: boolean) {
  const adapter = await navigator.gpu?.requestAdapter({
    powerPreference: "high-performance",
  });
  if (adapter || !required) return adapter ?? undefined;
  throw new Error(
    navigator.gpu
      ? "This browser found no WebGPU adapter."
      : "This browser does not support WebGPU.",
  );
}

interface Drawing {
  renderer: RendererName;
  garden: Omit<Garden, "render">;
  draw(): void;
  release(): void;
}

async function startWebGPU(
  canvas: HTMLCanvasElement,
  adapter: GPUAdapter,
  options: GardenOptions,
): Promise<Drawing> {
  const device = await adapter.requestDevice();
  void device.lost.then((info) => {
    if (info.reason !== "destroyed") console.error("WebGPU device lost", info);
  });
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("The canvas has no WebGPU context.");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const { createGarden } = await import("@opengardenjs/core/webgpu");
  const garden = createGarden(device, format, options);
  return {
    renderer: "webgpu",
    garden,
    draw: () => garden.render(context.getCurrentTexture().createView()),
    release: () => device.destroy(),
  };
}

async function startWebGL(
  canvas: HTMLCanvasElement,
  options: GardenOptions,
): Promise<Drawing> {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: options.quality?.antialias ?? true,
    depth: true,
    stencil: false,
    powerPreference: "high-performance",
  });
  if (!gl) throw new Error("This browser supports neither WebGPU nor WebGL2.");
  const { createWebGLGarden } = await import("@opengardenjs/core/webgl");
  const garden = createWebGLGarden(gl, options);
  return {
    renderer: "webgl",
    garden,
    draw: () => garden.render(),
    release: () => gl.getExtension("WEBGL_lose_context")?.loseContext(),
  };
}

/**
 * Adds a canvas to `host`, fills it with a garden and starts it. Draws with
 * WebGPU if the browser has it, and with WebGL2 if not.
 */
export async function mountGarden(
  host: HTMLElement,
  options: MountOptions,
): Promise<MountedGarden> {
  const choice = options.renderer ?? "auto";
  const adapter =
    choice === "webgl" ? undefined : await webgpuAdapter(choice === "webgpu");

  addStyle();
  const root = document.createElement("div");
  root.className = "og-garden";
  const canvas = document.createElement("canvas");
  root.append(canvas);
  host.append(root);

  const gardenOptions: GardenOptions = {
    species: options.species,
    seed: options.seed,
    season: options.season,
    atlas: paintAtlas(),
    trees: options.trees,
    scene: options.scene,
    offsetX: options.offsetX,
    quality: options.quality,
  };
  let drawing: Drawing;
  try {
    drawing = adapter
      ? await startWebGPU(canvas, adapter, gardenOptions)
      : await startWebGL(canvas, gardenOptions);
  } catch (error) {
    root.remove();
    throw error;
  }
  const { garden, draw } = drawing;
  const pixelRatio =
    Math.min(window.devicePixelRatio || 1, 2) * (options.renderScale ?? 1);
  const frameGap = options.maxFps ? (0.9 * 1000) / options.maxFps : 0;

  const resize = () => {
    canvas.width = Math.max(1, Math.floor(root.clientWidth * pixelRatio));
    canvas.height = Math.max(1, Math.floor(root.clientHeight * pixelRatio));
    garden.resize(canvas.width, canvas.height, pixelRatio);
  };
  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(root);

  const local = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) * canvas.clientWidth) / rect.width,
      ((event.clientY - rect.top) * canvas.clientHeight) / rect.height,
    ] as const;
  };
  const onPointerDown = (event: PointerEvent) => {
    garden.pointerDown(...local(event), event.pointerType !== "mouse");
    canvas.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    garden.pointerMove(...local(event));
    canvas.style.cursor = garden.overLeaves ? "pointer" : "";
  };
  const onPointerUp = (event: PointerEvent) =>
    garden.pointerUp(...local(event), event.type !== "pointerup");
  const onPointerLeave = () => {
    canvas.style.cursor = "";
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);

  const controls = options.controls
    ? createControls(root, garden.season, {
        onSeason: (season) => setSeason(season),
        onNewTree: () => garden.newTree(),
      })
    : undefined;
  const setSeason = (season: Season) => {
    garden.setSeason(season);
    controls?.select(season);
  };

  let frozen = false;
  let visible = !document.hidden;
  let last = performance.now();
  let frame = 0;
  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    if (now - last < frameGap) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!visible || frozen) return;
    garden.update(dt);
    draw();
  };
  frame = requestAnimationFrame(loop);

  const onVisibility = () => {
    visible = !document.hidden;
    last = performance.now();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const toLocal = (x: number, y: number) =>
    [x * canvas.clientWidth, y * canvas.clientHeight] as const;

  return {
    renderer: drawing.renderer,
    setSeason,
    setColors: (colors) => garden.setColors(colors),
    setOffsetX: (share) => garden.setOffsetX(share),
    newTree: (seed) => garden.newTree(seed),
    dispose() {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      garden.dispose();
      drawing.release();
      root.remove();
    },
    debug: {
      reset: () => garden.reset(),
      freeze(value) {
        frozen = value;
      },
      step(seconds) {
        garden.advance(seconds);
        draw();
      },
      touch(x, y, dx, dy) {
        garden.brush(...toLocal(x, y), dx, dy, 1 / 60);
      },
      click(x, y) {
        garden.gust(...toLocal(x, y));
      },
    },
  };
}
