export interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  type?: string;
  sideEffects?: boolean;
  files?: string[];
  keywords?: string[];
  bin?: Record<string, string>;
  repository?: { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: string;
  publishConfig?: { access?: string; provenance?: boolean };
  exports?: Record<string, Record<string, string>>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [field: string]: unknown;
}

export interface Package {
  /** Path from the workspace root, for example `packages/core`. */
  dir: string;
  /** The group directory, for example `packages`. */
  group: string;
  /** The directory name inside the group, for example `core`. */
  base: string;
  /** Absolute path of the package directory. */
  path: string;
  manifest: Manifest;
}

export interface Workspace {
  root: string;
  packages: readonly Package[];
  byName: ReadonlyMap<string, Package>;
}

export interface PackageRule {
  name: string;
  check(context: {
    pkg: Package;
    workspace: Workspace;
    /** Reports against `where`, which defaults to the package directory. */
    report: (message: string, where?: string) => void;
  }): void;
}

export interface WorkspaceRule {
  name: string;
  check(context: {
    workspace: Workspace;
    report: (message: string, where: string) => void;
  }): void;
}

export interface LayoutConfig {
  /** Maps each group directory at the root to the rules for every package in it. */
  groups: Readonly<Record<string, readonly PackageRule[]>>;
  /** Rules that look at all packages together. */
  rules?: readonly WorkspaceRule[];
  /** Root directories to skip. Dot directories are always skipped. */
  ignore?: readonly string[];
}

export interface Finding {
  rule: string;
  where: string;
  message: string;
}

export const defineLayout = (config: LayoutConfig): LayoutConfig => config;
