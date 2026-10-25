import "./window.ts";
import { chromium } from "playwright";

const [url = "http://localhost:5173/", out = "shots/mine.png", seconds = "5"] =
  process.argv.slice(2);
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: { width: 1232, height: 867 },
  deviceScaleFactor: 2,
});
page.on("console", (m) => console.log("console:", m.text()));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction(() => "garden" in window);
await page.evaluate((s) => {
  const { garden } = window;
  garden.debug.freeze(true);
  garden.debug.reset();
  garden.debug.step(Number(s));
}, seconds);
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await browser.close();
