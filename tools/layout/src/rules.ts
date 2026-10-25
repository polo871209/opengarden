import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  Package,
  PackageRule,
  Workspace,
  WorkspaceRule,
} from "./types.ts";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
] as const;
type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

const workspaceDependencies = (
  pkg: Package,
  workspace: Workspace,
  fields: readonly DependencyField[],
): Package[] =>
  fields.flatMap((field) =>
    Object.keys(pkg.manifest[field] ?? {}).flatMap((dep) => {
      const target = workspace.byName.get(dep);
      return target ? [target] : [];
    }),
  );

/** A package matches by its name, or when the predicate returns true. */
export type PackageMatch = string | ((pkg: Package) => boolean);

export const inGroup =
  (group: string) =>
  (pkg: Package): boolean =>
    pkg.group === group;

const matches = (match: PackageMatch, pkg: Package) =>
  typeof match === "string" ? match === pkg.manifest.name : match(pkg);

/** Names each package `scope/<directory>`, unless `overrides` maps its directory to a name. */
export const scopedName = (
  scope: string,
  overrides: Readonly<Record<string, string>> = {},
): PackageRule => ({
  name: "scoped-name",
  check({ pkg, report }) {
    const expected = overrides[pkg.dir] ?? `${scope}/${pkg.base}`;
    if (pkg.manifest.name !== expected)
      report(`must be named ${expected}, not ${pkg.manifest.name}`);
  },
});

export const moduleType = (): PackageRule => ({
  name: "module-type",
  check({ pkg, report }) {
    if (pkg.manifest.type !== "module") report(`must set "type": "module"`);
  },
});

/** Every dependency on a workspace package uses `protocol`. */
export const workspaceProtocol = (protocol = "workspace:^"): PackageRule => ({
  name: "workspace-protocol",
  check({ pkg, workspace, report }) {
    for (const field of DEPENDENCY_FIELDS)
      for (const [dep, range] of Object.entries(pkg.manifest[field] ?? {}))
        if (workspace.byName.has(dep) && range !== protocol)
          report(`${dep} must use "${protocol}", not "${range}"`);
  },
});

export const privatePackage = (): PackageRule => ({
  name: "private",
  check({ pkg, report }) {
    if (pkg.manifest.private !== true)
      report(`${pkg.group} packages must be private`);
  },
});

export const publicPackage = (): PackageRule => ({
  name: "public",
  check({ pkg, report }) {
    if (pkg.manifest.private) report("published packages must not be private");
  },
});

export const license = (id: string): PackageRule => ({
  name: "license",
  check({ pkg, report }) {
    if (pkg.manifest.license !== id) report(`must set "license": "${id}"`);
  },
});

/** The package holds a byte-for-byte copy of the root `file`. */
export const licenseCopy = (file = "LICENSE"): PackageRule => ({
  name: "license-copy",
  check({ pkg, workspace, report }) {
    const copy = join(pkg.path, file);
    const original = readFileSync(join(workspace.root, file), "utf8");
    if (!existsSync(copy) || readFileSync(copy, "utf8") !== original)
      report(`${file} must be a copy of the root ${file}`);
  },
});

/** Links the npm page of a package to its folder in the GitHub repository `owner/name`. */
export const githubLinks = (repo: string): PackageRule => ({
  name: "github-links",
  check({ pkg, report }) {
    const { repository, homepage, bugs } = pkg.manifest;
    // npm provenance rejects a publish when repository.url differs from the repository that runs the workflow.
    const url = `git+https://github.com/${repo}.git`;
    if (
      repository?.type !== "git" ||
      repository.url !== url ||
      repository.directory !== pkg.dir
    )
      report(
        `"repository" must be { "type": "git", "url": "${url}", "directory": "${pkg.dir}" }`,
      );
    const readme = `https://github.com/${repo}/tree/main/${pkg.dir}#readme`;
    if (homepage !== readme) report(`"homepage" must be "${readme}"`);
    const issues = `https://github.com/${repo}/issues`;
    if (bugs !== issues) report(`"bugs" must be "${issues}"`);
  },
});

export const publicWithProvenance = (): PackageRule => ({
  name: "publish-config",
  check({ pkg, report }) {
    const { access, provenance } = pkg.manifest.publishConfig ?? {};
    if (access !== "public" || provenance !== true)
      report(
        `must set "publishConfig": { "access": "public", "provenance": true }`,
      );
  },
});

export const publishedFiles = (files: readonly string[]): PackageRule => ({
  name: "published-files",
  check({ pkg, report }) {
    if (JSON.stringify(pkg.manifest.files) !== JSON.stringify(files))
      report(`must set "files": ${JSON.stringify(files)}`);
  },
});

export const requiredFiles = (files: readonly string[]): PackageRule => ({
  name: "required-files",
  check({ pkg, report }) {
    for (const file of files)
      if (!existsSync(join(pkg.path, file))) report(`has no ${file}`);
  },
});

/** `exports["."]` maps `condition` to `./src/main.ts` for a CLI, else to `./src/index.ts`. */
export const sourceEntry = (condition: string): PackageRule => ({
  name: "source-entry",
  check({ pkg, report }) {
    const entry = `./src/${pkg.manifest.bin ? "main.ts" : "index.ts"}`;
    if (pkg.manifest.exports?.["."]?.[condition] !== entry)
      report(`exports["."] must map "${condition}" to ${entry}`);
  },
});

/** Libraries set `"sideEffects": false`. A package with `bin` is exempt. */
export const sideEffectsFree = (): PackageRule => ({
  name: "side-effects",
  check({ pkg, report }) {
    if (!pkg.manifest.bin && pkg.manifest.sideEffects !== false)
      report(`libraries must set "sideEffects": false`);
  },
});

export const flatSource = (): PackageRule => ({
  name: "flat-source",
  check({ pkg, report }) {
    const src = join(pkg.path, "src");
    for (const file of existsSync(src) ? readdirSync(src) : [])
      if (statSync(join(src, file)).isDirectory() || !file.endsWith(".ts"))
        report(
          "src holds .ts files only, with no folders",
          `${pkg.dir}/src/${file}`,
        );
  },
});

/** Runtime and peer dependencies on workspace packages point at public packages only. */
export const noPrivateDependencies = (): PackageRule => ({
  name: "no-private-dependencies",
  check({ pkg, workspace, report }) {
    const targets = workspaceDependencies(pkg, workspace, [
      "dependencies",
      "peerDependencies",
    ]);
    for (const target of targets)
      if (target.manifest.private)
        report(
          `must not depend on the private package ${target.manifest.name}`,
        );
  },
});

export const keyword = (word: string): PackageRule => ({
  name: "keyword",
  check({ pkg, report }) {
    if (!pkg.manifest.keywords?.includes(word))
      report(`keywords must include "${word}"`);
  },
});

export const exactPeers = (peers: readonly string[]): PackageRule => ({
  name: "exact-peers",
  check({ pkg, report }) {
    const actual = Object.keys(pkg.manifest.peerDependencies ?? {});
    if (actual.join() !== peers.join())
      report(`peerDependencies must be exactly ${peers.join(", ")}`);
  },
});

/** Runtime dependencies come from `allowed` only. */
export const onlyDependencies = (allowed: readonly string[]): PackageRule => ({
  name: "only-dependencies",
  check({ pkg, report }) {
    for (const dep of Object.keys(pkg.manifest.dependencies ?? {}))
      if (!allowed.includes(dep))
        report(`may only depend on ${allowed.join(", ")}, not ${dep}`);
  },
});

/**
 * Maps each package name to the workspace packages it may depend on at runtime.
 * A package that is missing from `graph` fails.
 */
export const dependencyGraph = (
  graph: Readonly<Record<string, readonly PackageMatch[]>>,
): PackageRule => ({
  name: "dependency-graph",
  check({ pkg, workspace, report }) {
    const allowed = graph[pkg.manifest.name ?? ""];
    if (!allowed) {
      report("has no entry in the dependency-graph rule");
      return;
    }
    for (const target of workspaceDependencies(pkg, workspace, [
      "dependencies",
    ]))
      if (!allowed.some((match) => matches(match, target)))
        report(
          `${pkg.manifest.name} must not depend on ${target.manifest.name}`,
        );
  },
});

/** Published packages share one version, so one `v<version>` tag releases them all. */
export const sharedVersion = (): WorkspaceRule => ({
  name: "shared-version",
  check({ workspace, report }) {
    const published = workspace.packages.filter((pkg) => !pkg.manifest.private);
    const versions = new Set(published.map((pkg) => pkg.manifest.version));
    if (versions.size > 1)
      report(
        `published packages must share one version: ${published.map((pkg) => `${pkg.dir} ${pkg.manifest.version}`).join(", ")}`,
        "version",
      );
  },
});

/** Every external dependency uses one range across the workspace. */
export const singleRange = (): WorkspaceRule => ({
  name: "single-range",
  check({ workspace, report }) {
    const ranges = new Map<string, Map<string, string>>();
    for (const pkg of workspace.packages)
      for (const field of DEPENDENCY_FIELDS)
        for (const [dep, range] of Object.entries(pkg.manifest[field] ?? {})) {
          if (workspace.byName.has(dep)) continue;
          const seen = ranges.get(dep) ?? new Map<string, string>();
          seen.set(pkg.dir, range);
          ranges.set(dep, seen);
        }
    for (const [dep, seen] of ranges)
      if (new Set(seen.values()).size > 1)
        report(
          `uses different ranges: ${[...seen].map(([dir, range]) => `${dir} ${range}`).join(", ")}`,
          dep,
        );
  },
});
