import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { cherry } from "@opengardenjs/cherry";
import { createGarden, type Garden } from "@opengardenjs/core";
import {
  type Capturer,
  createCapturer,
  createKittyScreen,
  dawnGpu,
  type KittyScreen,
  paintAtlas,
  screenScale,
} from "@opengardenjs/terminal";
import { median, percentile } from "./stats.ts";

const { values: args } = parseArgs({
  options: {
    "pixel-ratio": { type: "string", default: "1" },
    frames: { type: "string", default: "600" },
    seed: { type: "string", default: "7" },
    check: { type: "boolean", default: false },
  },
});
const FRAME_MS = 1000 / 60;
const WARMUP_FRAMES = 60;

async function main() {
  const adapter = await dawnGpu().requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("WebGPU found no GPU adapter");
  const device = await adapter.requestDevice();
  device.addEventListener("uncapturederror", (event) => {
    console.error(
      `GPU error: ${(event as GPUUncapturedErrorEvent).error.message}`,
    );
    process.exit(1);
  });
  const garden = createGarden(device, "rgba8unorm", {
    species: cherry,
    seed: Number(args.seed),
    atlas: paintAtlas(),
  });
  const screen = createKittyScreen();
  const pixelRatio = Number(args["pixel-ratio"]);
  const rexPane = { columns: 101, rows: 61, cellWidth: 20, cellHeight: 39 };
  const { width, height } = screen.layout(
    rexPane,
    pixelRatio / screenScale(rexPane),
  );
  const capturer = createCapturer(device, garden, "rgba8unorm");
  capturer.resize(width, height);
  garden.resize(width, height, pixelRatio);

  const metrics = args.check
    ? await check(screen, capturer, garden, width, height)
    : await measure(screen, capturer, garden);
  screen.dispose();
  device.destroy();
  console.log(JSON.stringify({ size: `${width}x${height}`, metrics }));
}

async function measure(
  screen: KittyScreen,
  capturer: Capturer,
  garden: Garden,
) {
  const sink = openSync("/dev/null", "w");
  const frames = Number(args.frames);
  const frameMs: number[] = [];
  let bytes = 0;
  let edits = 0;
  let cpu = process.cpuUsage();
  let started = performance.now();
  garden.advance(1 / 60);
  capturer.render();
  for (let frame = 0; frame < WARMUP_FRAMES + frames; frame++) {
    if (frame === WARMUP_FRAMES) {
      cpu = process.cpuUsage();
      started = performance.now();
    }
    const due = started + (frame - WARMUP_FRAMES + 1) * FRAME_MS;
    const before = performance.now();
    const capture = await capturer.read();
    const shown = screen.present(capture, frame === 0);
    capture.release();
    writeSync(sink, Buffer.from(shown.sequence, "latin1"));
    garden.advance(1 / 60);
    capturer.render();
    if (frame >= WARMUP_FRAMES) {
      frameMs.push(performance.now() - before);
      bytes += shown.bytes;
      edits += shown.edits;
    }
    await sleep(Math.max(0, due - performance.now()));
  }
  (await capturer.read()).release();
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  closeSync(sink);
  return {
    "app cpu %": (100 * (used.user + used.system)) / 1000 / wallMs,
    "frame ms p50": median(frameMs),
    "frame ms p95": percentile(frameMs, 0.95),
    "kB/frame": bytes / frames / 1000,
    "edits/frame": edits / frames,
  };
}

async function check(
  screen: KittyScreen,
  capturer: Capturer,
  garden: Garden,
  width: number,
  height: number,
) {
  const shown = new Uint8Array(width * height * 3);
  const frames = 150;
  for (let frame = 0; frame < frames; frame++) {
    garden.advance(1 / 60);
    if (frame === 60) garden.newTree(Number(args.seed) + 1);
    if (frame === 100) {
      garden.pointerDown(width / 2 - 20, height / 2, false);
      garden.pointerMove(width / 2 + 20, height / 2);
      garden.pointerUp(width / 2 + 20, height / 2, false);
    }
    capturer.render();
    const capture = await capturer.read();
    const { sequence } = screen.present(capture, frame === 0);
    for (const [, head, payload] of sequence.matchAll(
      /\x1b_G([^;]*);([^\x1b]*)\x1b\\/g,
    )) {
      const keys = Object.fromEntries(
        head.split(",").map((pair) => pair.split("=")),
      );
      const file = readFileSync(Buffer.from(payload, "base64").toString());
      const offset = Number(keys.O ?? 0);
      const data = file.subarray(offset, offset + Number(keys.S));
      const [x, y, w, h] = [keys.x ?? 0, keys.y ?? 0, keys.s, keys.v].map(
        Number,
      );
      if (keys.a === "T" && (w !== width || h !== height))
        throw new Error(`frame ${frame}: whole image is ${w}x${h}`);
      if (x + w > width || y + h > height)
        throw new Error(
          `frame ${frame}: edit ${x},${y} ${w}x${h} leaves the image`,
        );
      for (let row = 0; row < h; row++)
        shown.set(
          data.subarray(row * w * 3, (row + 1) * w * 3),
          ((y + row) * width + x) * 3,
        );
    }
    const wrong = shown.findIndex((value, i) => value !== capture.rgb[i]);
    capture.release();
    if (wrong >= 0) {
      const pixel = Math.floor(wrong / 3);
      throw new Error(
        `frame ${frame}: pixel ${pixel % width},${Math.floor(pixel / width)} differs from the render`,
      );
    }
  }
  return { "checked frames": frames };
}

await main();
