import "./window.ts";
import { chromium } from "playwright";

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: { width: 1232, height: 867 },
  deviceScaleFactor: 1,
});
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto("http://localhost:5173/", {
  waitUntil: "load",
  timeout: 20000,
});
await page.waitForFunction(() => "garden" in window);
await page.evaluate(() => {
  window.garden.debug.freeze(true);
  window.garden.debug.reset();
  window.garden.debug.step(3);
});
await page.screenshot({ path: "shots/ui.png" });
await page.evaluate(() => {
  window.garden.newTree(42);
  window.garden.debug.step(0.25);
});
await page.screenshot({ path: "shots/blow.png" });
await page.evaluate(() => {
  window.garden.debug.step(0.4);
  window.garden.debug.step(0.8);
});
await page.screenshot({ path: "shots/regrow.png" });
await page.evaluate(() => window.garden.debug.step(3));
await page.screenshot({ path: "shots/seed42.png" });
const fps = await page.evaluate(async () => {
  window.garden.debug.freeze(false);
  let frames = 0;
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      frames++;
      if (performance.now() - start < 3000) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  return frames / ((performance.now() - start) / 1000);
});
console.log("fps", fps.toFixed(1));
await browser.close();
