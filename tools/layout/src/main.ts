#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkLayout } from "./check.ts";
import { defaultLayout } from "./default.ts";
import type { LayoutConfig } from "./types.ts";

const { values: args } = parseArgs({
  options: {
    root: { type: "string", default: "." },
    config: { type: "string" },
  },
});

const root = resolve(args.root);
const configPath = args.config
  ? resolve(args.config)
  : join(root, "layout.config.ts");
const config: LayoutConfig =
  args.config || existsSync(configPath)
    ? (
        (await import(pathToFileURL(configPath).href)) as {
          default: LayoutConfig;
        }
      ).default
    : defaultLayout;

const findings = checkLayout(config, root);
if (findings.length) {
  for (const { rule, where, message } of findings)
    console.error(`${where}: ${message} (${rule})`);
  process.exit(1);
}
console.log("layout ok");
