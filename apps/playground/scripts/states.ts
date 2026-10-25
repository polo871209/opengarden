import { chromium, type ElementHandle, type Page } from "playwright";

const target = process.argv[2] ?? "mine";
const isRef = target === "ref";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: isRef
    ? { width: 1600, height: 1000 }
    : { width: 1232, height: 867 },
  deviceScaleFactor: 1,
});
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("console:", m.text());
});

let handle: string;
if (isRef) {
  await page.goto("https://metalforge.xyz/tree", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  handle = "document.querySelector('[data-tree-stage]').__tree";
  await page.evaluate(`${handle}.set({ controls: false })`);
} else {
  await page.goto("http://localhost:5173/", {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => "garden" in window);
  handle = "window.garden";
}
const run = (code: string) =>
  page.evaluate(`(() => { const g = ${handle}; ${code} })()`);
const setSeason = (season: string) =>
  isRef ? `g.set({ season: '${season}' })` : `g.setSeason('${season}')`;
const shot = async (name: string) => {
  const element: Page | ElementHandle | null = isRef
    ? await page.$("[data-tree-stage]")
    : page;
  await element?.screenshot({ path: `shots/${target}-${name}.png` });
};

await run("g.debug.freeze(true); g.debug.reset(); g.debug.step(3);");
await run(
  "for (let i = 0; i <= 40; i++) { g.debug.touch(0.3 + i * 0.01, 0.38 + Math.sin(i / 6) * 0.04, 12, 2); g.debug.step(1 / 60); }",
);
await run("g.debug.step(0.4);");
await shot("hover-air");
await run("g.debug.step(4);");
await shot("hover-ground");
await run("g.debug.click(0.62, 0.4); g.debug.step(0.6);");
await shot("click-air");
await run("g.debug.step(5);");
await shot("click-ground");
await run(`${setSeason("summer")}; g.debug.step(0.4);`);
await shot("wipe");
await run("g.debug.step(1);");
await shot("summer");
for (const season of ["autumn", "winter"]) {
  await run(`${setSeason(season)}; g.debug.step(4);`);
  await shot(season);
}
await browser.close();
