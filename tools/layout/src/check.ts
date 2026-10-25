import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  Finding,
  LayoutConfig,
  Manifest,
  Package,
  Workspace,
} from "./types.ts";

const isDirectory = (path: string) => statSync(path).isDirectory();

export function checkLayout(config: LayoutConfig, root: string): Finding[] {
  const findings: Finding[] = [];
  const groups = Object.keys(config.groups);
  const ignore = new Set(config.ignore ?? ["node_modules"]);
  const reportLayout = (where: string, message: string) =>
    findings.push({ rule: "groups", where, message });

  const packages: Package[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (name.startsWith(".") || ignore.has(name) || !isDirectory(path))
      continue;
    if (!groups.includes(name)) {
      if (existsSync(join(path, "package.json")))
        reportLayout(name, `packages live in ${groups.join(", ")}`);
      continue;
    }
    for (const base of readdirSync(path)) {
      const dir = `${name}/${base}`;
      const packagePath = join(path, base);
      if (!isDirectory(packagePath)) {
        reportLayout(dir, "only package directories belong here");
        continue;
      }
      const manifestPath = join(packagePath, "package.json");
      if (!existsSync(manifestPath)) {
        reportLayout(dir, "has no package.json");
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      packages.push({
        dir,
        group: name,
        base,
        path: packagePath,
        manifest: manifest as Manifest,
      });
    }
  }

  const workspace: Workspace = {
    root,
    packages,
    byName: new Map(packages.map((pkg) => [pkg.manifest.name ?? "", pkg])),
  };

  for (const pkg of packages)
    for (const rule of config.groups[pkg.group] ?? [])
      rule.check({
        pkg,
        workspace,
        report: (message, where = pkg.dir) =>
          findings.push({ rule: rule.name, where, message }),
      });

  for (const rule of config.rules ?? [])
    rule.check({
      workspace,
      report: (message, where) =>
        findings.push({ rule: rule.name, where, message }),
    });

  return findings;
}
