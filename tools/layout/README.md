# @opengardenjs/layout

Checks that every package in the workspace sits in the right group and has a correct `package.json`. `pnpm lint` runs it.

```sh
node tools/layout/src/main.ts [--root DIR] [--config FILE]
```

The command reads `--config`, or else `layout.config.ts` in the root. If neither exists, it uses `defaultLayout` from `src/default.ts`, which is the opengarden layout. Each failure prints as `where: message (rule)`, and any failure exits with code 1.

## Write a configuration

A configuration maps each group directory at the root to the rules for every package in it. `rules` holds rules that look at all packages together.

```ts
// layout.config.ts
import {
  defaultLayout,
  defineLayout,
  privateRules,
  requiredFiles,
} from "./tools/layout/src/index.ts";

export default defineLayout({
  ...defaultLayout,
  groups: {
    ...defaultLayout.groups,
    examples: [...privateRules, requiredFiles(["README.md"])],
  },
});
```

To drop a rule, filter it by name: `publishedRules.filter((rule) => rule.name !== "flat-source")`.

## Write a rule

A rule is an object with a `name` and a `check` function. A package rule gets the package, the workspace and `report`. A workspace rule gets the workspace and `report`.

```ts
import type { PackageRule } from "./tools/layout/src/index.ts";

const hasDescription: PackageRule = {
  name: "description",
  check({ pkg, report }) {
    if (!pkg.manifest.description) report("must set a description");
  },
};
```

## Built-in rules

The rules in `src/rules.ts` are factories, so call each one with its options:

- Every package: `scopedName`, `moduleType`, `workspaceProtocol`, `privatePackage`, `publicPackage`, `keyword`.
- Published files: `license`, `licenseCopy`, `githubLinks`, `publicWithProvenance`, `publishedFiles`, `requiredFiles`, `sourceEntry`, `sideEffectsFree`, `flatSource`.
- Dependencies: `noPrivateDependencies`, `dependencyGraph`, `exactPeers`, `onlyDependencies`.
- Workspace: `singleRange`, `sharedVersion`.

`src/default.ts` groups them into `commonRules`, `publishedRules` and `privateRules`.
