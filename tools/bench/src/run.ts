import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { median } from "./stats.ts";

const MIN_RUNS = 5;

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    runs: { type: "string", default: String(MIN_RUNS) },
    save: { type: "string" },
    baseline: { type: "string" },
  },
});

const CASES: { name: string; suite: string; args: string[] }[] = [
  { name: "terminal 1x", suite: "terminal", args: ["--pixel-ratio", "1"] },
  { name: "terminal 2x", suite: "terminal", args: ["--pixel-ratio", "2"] },
  { name: "browser", suite: "browser", args: [] },
  { name: "rex 1x", suite: "rex", args: ["--pixel-ratio", "1"] },
  { name: "rex 2x", suite: "rex", args: ["--pixel-ratio", "2"] },
];
const HIGHER_IS_BETTER = new Set(["fps"]);

interface Result {
  size: string;
  metrics: Record<string, number>;
}

interface Saved {
  machine: string;
  cases: Record<string, { size: string; metrics: Record<string, number[]> }>;
}

const suites = (
  args.only ??
  (process.env.REX_SESSION ? "terminal,browser,rex" : "terminal,browser")
).split(",");
const nodeArgs = (suite: string, suiteArgs: string[]) => [
  ...process.execArgv,
  fileURLToPath(new URL(`./${suite}.ts`, import.meta.url)),
  ...suiteArgs,
];

const saved: Saved = {
  machine: `${cpus()[0].model}, ${platform()} ${release()}, node ${process.version}`,
  cases: {},
};

if (suites.includes("terminal")) {
  process.stderr.write("terminal check\n");
  for (const pixelRatio of ["1", "2"])
    execFileSync(
      process.execPath,
      nodeArgs("terminal", ["--check", "--pixel-ratio", pixelRatio]),
      { stdio: ["ignore", "ignore", "inherit"] },
    );
}

for (let run = 1; run <= Number(args.runs); run++) {
  for (const { name, suite, args: caseArgs } of CASES) {
    if (!suites.includes(suite)) continue;
    process.stderr.write(`${name} run ${run}/${args.runs}\n`);
    const output = execFileSync(process.execPath, nodeArgs(suite, caseArgs), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const result = JSON.parse(output.trim().split("\n").at(-1) ?? "") as Result;
    const entry = saved.cases[name] ?? { size: result.size, metrics: {} };
    saved.cases[name] = entry;
    for (const [metric, value] of Object.entries(result.metrics))
      entry.metrics[metric] = [...(entry.metrics[metric] ?? []), value];
  }
}

const baseline = args.baseline
  ? (JSON.parse(readFileSync(args.baseline, "utf8")) as Saved)
  : undefined;
const format = (value: number) =>
  Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
const range = (values: number[]) =>
  `${format(Math.min(...values))}–${format(Math.max(...values))}`;

function verdict(metric: string, now: number[], before: number[]): string {
  if (Math.min(now.length, before.length) < MIN_RUNS) return "too few runs";
  const lower = Math.max(...now) < Math.min(...before);
  const higher = Math.min(...now) > Math.max(...before);
  if (!lower && !higher) return "noise";
  return lower !== HIGHER_IS_BETTER.has(metric) ? "better" : "worse";
}

console.log(saved.machine);
if (baseline && baseline.machine !== saved.machine)
  console.log(`baseline machine differs: ${baseline.machine}`);
for (const [name, entry] of Object.entries(saved.cases)) {
  const old = baseline?.cases[name];
  const sizeNote =
    old && old.size !== entry.size ? ` (baseline was ${old.size})` : "";
  console.log(`\n${name} at ${entry.size}${sizeNote}`);
  for (const [metric, values] of Object.entries(entry.metrics)) {
    let line = `  ${metric.padEnd(16)} ${format(median(values)).padStart(8)}  (${range(values)})`;
    const before = old?.metrics[metric];
    if (before) {
      const change = (100 * (median(values) - median(before))) / median(before);
      line += `  was ${format(median(before))}, ${change >= 0 ? "+" : ""}${change.toFixed(0)}% ${verdict(metric, values, before)}`;
    }
    console.log(line);
  }
}
if (args.save) {
  const kept = existsSync(args.save)
    ? (JSON.parse(readFileSync(args.save, "utf8")) as Saved).cases
    : {};
  const cases = Object.fromEntries(
    CASES.map(({ name }) => [name, saved.cases[name] ?? kept[name]]).filter(
      ([, entry]) => entry,
    ),
  );
  writeFileSync(args.save, `${JSON.stringify({ ...saved, cases }, null, 2)}\n`);
}
