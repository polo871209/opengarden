#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cherry } from "@opengardenjs/cherry";
import { SEASONS } from "@opengardenjs/core";
import { runInTerminal } from "@opengardenjs/terminal";

const HELP = `Usage: opengarden [options]

Grows a tree in a terminal that supports the Kitty graphics protocol.

Options:
  --seed <n>           grow the tree from this seed
  --season <name>      start in ${SEASONS.join(", ")}
  --controls           show the hint and the season and new tree buttons
  --pixel-ratio <n>    rendered pixels per screen pixel, above 0 and at most 2 (default 1)
  --log <file>         append events and frame stats to this file
  -h, --help           show this help

Keys: 1-4 change the season, n grows a new tree, q quits.
`;

const { values: args } = parseArgs({
  options: {
    seed: { type: "string" },
    season: { type: "string" },
    controls: { type: "boolean" },
    "pixel-ratio": { type: "string", default: "1" },
    log: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const season = SEASONS.find((value) => value === args.season);
if (args.season && !season) {
  process.stderr.write(`--season must be one of ${SEASONS.join(", ")}\n`);
  process.exit(2);
}

const logFile = args.log;
try {
  await runInTerminal({
    species: cherry,
    seed: Number(args.seed) || undefined,
    season,
    controls: args.controls,
    pixelRatio: Number(args["pixel-ratio"]),
    log: logFile
      ? (line) =>
          appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
      : undefined,
  });
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
