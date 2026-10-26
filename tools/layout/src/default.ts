import {
  dependencyGraph,
  exactPeers,
  flatSource,
  githubLinks,
  inGroup,
  keyword,
  license,
  licenseCopy,
  moduleType,
  noPrivateDependencies,
  onlyDependencies,
  privatePackage,
  publicPackage,
  publicWithProvenance,
  publishedFiles,
  requiredFiles,
  scopedName,
  sharedVersion,
  sideEffectsFree,
  singleRange,
  sourceEntry,
  workspaceProtocol,
} from "./rules.ts";
import { defineLayout, type PackageRule } from "./types.ts";

export const commonRules: readonly PackageRule[] = [
  scopedName("@opengardenjs", { "packages/cli": "opengarden" }),
  moduleType(),
  workspaceProtocol(),
];

export const publishedRules: readonly PackageRule[] = [
  ...commonRules,
  publicPackage(),
  license("MIT"),
  licenseCopy(),
  githubLinks("polo871209/opengarden"),
  publicWithProvenance(),
  publishedFiles(["dist"]),
  requiredFiles(["tsconfig.build.json", "README.md"]),
  sourceEntry("@opengardenjs/source"),
  sideEffectsFree(),
  flatSource(),
  noPrivateDependencies(),
];

export const privateRules: readonly PackageRule[] = [
  ...commonRules,
  privatePackage(),
];

export const defaultLayout = defineLayout({
  groups: {
    packages: [
      ...publishedRules,
      dependencyGraph({
        "@opengardenjs/core": [],
        "@opengardenjs/web": ["@opengardenjs/core"],
        "@opengardenjs/terminal": ["@opengardenjs/core"],
        opengarden: [
          "@opengardenjs/core",
          "@opengardenjs/terminal",
          inGroup("trees"),
        ],
      }),
    ],
    trees: [
      ...publishedRules,
      keyword("opengarden-tree"),
      exactPeers(["@opengardenjs/core"]),
      onlyDependencies([]),
    ],
    apps: privateRules,
    tools: privateRules,
  },
  rules: [singleRange(), sharedVersion()],
});
