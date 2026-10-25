import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MountedGarden } from "@opengardenjs/web";
import { chromium } from "playwright";
import { createServer } from "vite";

const WIDTH = 1232;
const HEIGHT = 867;
const FPS_SECONDS = 5;

declare global {
  interface Window {
    garden: MountedGarden;
  }
}

const server = await createServer({
  root: dirname(
    fileURLToPath(import.meta.resolve("@opengardenjs/playground/index.html")),
  ),
  logLevel: "silent",
  server: { port: 0 },
});
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("vite did not report a URL");

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--disable-gpu-vsync",
    "--disable-frame-rate-limit",
  ],
});
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      errors.push(message.text());
  });
  await page.goto(`${url}?seed=7`, { waitUntil: "networkidle" });
  await page
    .waitForFunction(() => "garden" in window, null, { timeout: 20_000 })
    .catch(() => {
      throw new Error(
        `the garden did not start: ${errors.join("; ") || "no page errors"}`,
      );
    });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const scriptSeconds = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return (
      metrics.find((metric) => metric.name === "ScriptDuration")?.value ?? 0
    );
  };
  await page.evaluate(async () => {
    window.garden.debug.reset();
    for (let i = 0; i < 60; i++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  const scriptBefore = await scriptSeconds();
  const frames = await page.evaluate(async (seconds) => {
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(resolve));
    const started = performance.now();
    let count = 0;
    while (performance.now() - started < seconds * 1000) {
      await frame();
      count++;
    }
    return { count, seconds: (performance.now() - started) / 1000 };
  }, FPS_SECONDS);
  const scriptMs =
    (1000 * ((await scriptSeconds()) - scriptBefore)) / frames.count;

  const heap = await page.evaluate(
    () =>
      (performance as unknown as { memory: { usedJSHeapSize: number } }).memory
        .usedJSHeapSize,
  );
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);

  console.log(
    JSON.stringify({
      size: `${WIDTH * 2}x${HEIGHT * 2}`,
      metrics: {
        fps: frames.count / frames.seconds,
        "script ms/frame": scriptMs,
        "heap MB": heap / 1e6,
      },
    }),
  );
} finally {
  await browser.close();
  await server.close();
}
