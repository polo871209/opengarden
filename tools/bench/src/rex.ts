// The Rex split must be visible, because a hidden pane renders at the 80×24 fallback size.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { "pixel-ratio": { type: "string", default: "1" } },
});
const SAMPLE_SECONDS = 15;
const REX_PROCESS = /RexServer|\/Rex( Beta)?\.app\//;

const session = process.env.REX_SESSION;
const block = process.env.REX_BLOCK;
if (!session || !block)
  throw new Error("the rex bench needs REX_SESSION and REX_BLOCK");

interface Process {
  parent: number;
  rssKb: number;
  cpuSeconds: number;
  command: string;
}

function processes(): Map<number, Process> {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], {
    encoding: "utf8",
  });
  const table = new Map<number, Process>();
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const parts = match[4].split(":").map(Number);
    const cpuSeconds = parts.reduce((total, part) => total * 60 + part, 0);
    table.set(Number(match[1]), {
      parent: Number(match[2]),
      rssKb: Number(match[3]),
      cpuSeconds,
      command: match[5],
    });
  }
  return table;
}

function tree(table: Map<number, Process>, marker: string): number[] {
  const pids = [...table].filter(([, p]) => p.command.includes(marker));
  const found = new Set(pids.map(([pid]) => pid));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, p] of table)
      if (found.has(p.parent) && !found.has(pid)) {
        found.add(pid);
        grew = true;
      }
  }
  return [...found];
}

const cpuSeconds = (table: Map<number, Process>, pids: number[]) =>
  pids.reduce((total, pid) => total + (table.get(pid)?.cpuSeconds ?? 0), 0);

const rexPids = (table: Map<number, Process>) =>
  [...table].filter(([, p]) => REX_PROCESS.test(p.command)).map(([pid]) => pid);

const directory = mkdtempSync(join(tmpdir(), "opengarden-bench-"));
const log = join(directory, "log");
const split = JSON.parse(
  execFileSync(
    "rex",
    [
      "split",
      ...["-s", session, "-b", block, "--split=right", "--ratio", "60"],
      ...["--focus=false", "--keep-open", "--json", "--"],
      ...[process.execPath, ...process.execArgv],
      ...[fileURLToPath(import.meta.resolve("opengarden")), "--seed", "7"],
      ...["--log", log],
      ...["--pixel-ratio", args["pixel-ratio"]],
    ],
    { encoding: "utf8" },
  ),
) as { block_ids: string[] };
const pane = split.block_ids[0];

try {
  const readLog = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  for (let waited = 0; !/ fps [1-9]/.test(readLog()); waited += 100) {
    if (waited > 20_000) throw new Error(`no frames after 20 s:\n${readLog()}`);
    await sleep(100);
  }
  await sleep(3000);

  const before = processes();
  const sampleStart = new Date();
  await sleep(SAMPLE_SECONDS * 1000);
  const after = processes();
  const app = tree(after, `--log ${log}`);

  const text = readLog();
  const size = /rendering (\d+×\d+)px/.exec(text)?.[1] ?? "unknown";
  if (text.includes("80×24 cells of 8×16px"))
    process.stderr.write(
      "warning: Rex reported its fallback size, so the split is probably in a hidden tab\n",
    );
  const seconds = text
    .split("\n")
    .filter(
      (line) =>
        line.includes(" fps ") && new Date(line.slice(0, 24)) > sampleStart,
    )
    .map((line) => {
      const fields = line.split(" ");
      const value = (name: string) =>
        Number.parseFloat(fields[fields.indexOf(name) + 1]);
      return {
        fps: value("fps"),
        kB: value("kB/frame"),
        edits: value("edits/frame"),
        terminalMs: value("terminal"),
      };
    });
  const mean = (pick: (second: (typeof seconds)[number]) => number) =>
    seconds.reduce((total, second) => total + pick(second), 0) / seconds.length;
  const errors = text
    .split("\n")
    .filter((line) => /graphics:|missed/.test(line));

  console.log(
    JSON.stringify({
      size: size.replace("×", "x"),
      metrics: {
        fps: mean((second) => second.fps),
        "app cpu %":
          (100 * (cpuSeconds(after, app) - cpuSeconds(before, app))) /
          SAMPLE_SECONDS,
        "rex cpu %":
          (100 *
            (cpuSeconds(after, rexPids(after)) -
              cpuSeconds(before, rexPids(after)))) /
          SAMPLE_SECONDS,
        "app MB":
          app.reduce((total, pid) => total + (after.get(pid)?.rssKb ?? 0), 0) /
          1024,
        "kB/frame": mean((second) => second.kB),
        "edits/frame": mean((second) => second.edits),
        "terminal ms": mean((second) => second.terminalMs),
        "graphics errors": errors.length,
      },
    }),
  );
} finally {
  execFileSync("rex", ["send", "-s", session, "-b", pane, "q"]);
  await sleep(1500);
  execFileSync("rex", ["block", "close", "-s", session, pane], {
    stdio: "ignore",
  });
  rmSync(directory, { recursive: true, force: true });
}
