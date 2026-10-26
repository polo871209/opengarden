import {
  ATLAS_HEIGHT,
  ATLAS_WIDTH,
  createGarden,
  paintLeafAtlas,
  type SceneColors,
  type Season,
  type Species,
} from "@opengardenjs/core";
import { addStyle, createControls } from "./controls.ts";

export interface MountOptions {
  species: Species;
  seed?: number;
  season?: Season;
  /** Shows the hint and the season and new tree buttons. Defaults to false. */
  controls?: boolean;
  /** Replaces these scene colors in every season. `ground` is also the color behind the garden. */
  scene?: Partial<SceneColors>;
  /** Moves the tree right by this share of the canvas width. Negative moves it left. Defaults to 0. */
  offsetX?: number;
}

/** A garden that runs in a canvas inside the host element. */
export interface MountedGarden {
  setSeason(season: Season): void;
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

/** Adds a canvas to `host`, fills it with a garden and starts it. Needs WebGPU. */
export async function mountGarden(
  host: HTMLElement,
  options: MountOptions,
): Promise<MountedGarden> {
  if (!navigator.gpu) throw new Error("This browser does not support WebGPU.");
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("This browser found no WebGPU adapter.");
  const device = await adapter.requestDevice();
  void device.lost.then((info) => {
    if (info.reason !== "destroyed") console.error("WebGPU device lost", info);
  });

  addStyle();
  const root = document.createElement("div");
  root.className = "og-garden";
  const canvas = document.createElement("canvas");
  root.append(canvas);
  host.append(root);
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("The canvas has no WebGPU context.");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const garden = createGarden(device, format, {
    species: options.species,
    seed: options.seed,
    season: options.season,
    atlas: paintAtlas(),
    scene: options.scene,
    offsetX: options.offsetX,
  });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  const resize = () => {
    canvas.width = Math.max(1, Math.floor(root.clientWidth * pixelRatio));
    canvas.height = Math.max(1, Math.floor(root.clientHeight * pixelRatio));
    garden.resize(canvas.width, canvas.height, pixelRatio);
  };
  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(root);

  const draw = () => garden.render(context.getCurrentTexture().createView());

  const local = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top] as const;
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
    setSeason,
    setOffsetX: (share) => garden.setOffsetX(share),
    newTree: (seed) => garden.newTree(seed),
    dispose() {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      garden.dispose();
      device.destroy();
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
