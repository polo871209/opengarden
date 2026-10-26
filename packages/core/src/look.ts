import { Vector3 } from "./math.ts";

export type Season = "spring" | "summer" | "autumn" | "winter";
export const SEASONS: readonly Season[] = [
  "spring",
  "summer",
  "autumn",
  "winter",
];

export const ATLAS_CELL = { blossom: 0, dab: 1, leaf: 2 } as const;
export const ATLAS_CELLS = 3;
export type LeafShape = keyof typeof ATLAS_CELL;

/** The colors and leaf shape of one tree in one season. Colors are `#rrggbb`. */
export interface TreeLook {
  /** Crown colors from shade to light. */
  crown: readonly [string, string, string, string];
  leaf: LeafShape;
  bark: string;
  barkShade: string;
}

/** The colors around the tree in one season. Colors are `#rrggbb`. */
export interface SceneColors {
  /** Also the color behind the garden. */
  ground: string;
  gravel: string;
  rake: string;
  shadow: string;
  moss: string;
  mossLight: string;
  mossShade: string;
  rock: string;
  rockShade: string;
  sun: string;
  /** Snow on bark and stones in winter. */
  snow: string;
}

/** Colors that replace the species' and the garden's own. */
export interface Colors {
  /** Replaces the species' tree look in these seasons. */
  trees?: Partial<Record<Season, TreeLook>>;
  /**
   * Replaces these scene colors in every season, or in each season that the
   * function is called with. `ground` is also the color behind the garden.
   */
  scene?: Partial<SceneColors> | ((season: Season) => Partial<SceneColors>);
}

const SCENE: Record<Season, SceneColors> = {
  spring: {
    ground: "#ffe9f5",
    gravel: "#f8e0ee",
    rake: "#e9cfe0",
    shadow: "#8e8597",
    moss: "#8cc8ac",
    mossLight: "#a8d8b4",
    mossShade: "#6aa7a6",
    rock: "#ddd2e4",
    rockShade: "#9a92b4",
    sun: "#fff6f2",
    snow: "#f4f9fc",
  },
  summer: {
    ground: "#c3effe",
    gravel: "#bfe8f6",
    rake: "#a9d9ea",
    shadow: "#6d899c",
    moss: "#59c3b4",
    mossLight: "#7fd3a8",
    mossShade: "#3a9a9a",
    rock: "#cfe2ea",
    rockShade: "#86a2b4",
    sun: "#fffbe8",
    snow: "#f4f9fc",
  },
  autumn: {
    ground: "#fff8df",
    gravel: "#fbefd0",
    rake: "#efdcb4",
    shadow: "#908e8c",
    moss: "#eb5a1e",
    mossLight: "#f39a3a",
    mossShade: "#b8442a",
    rock: "#ece2cc",
    rockShade: "#a89a8c",
    sun: "#fff4dc",
    snow: "#f4f9fc",
  },
  winter: {
    ground: "#3a8fcb",
    gravel: "#4596cf",
    rake: "#5aa3d6",
    shadow: "#2e5a84",
    moss: "#e4eef4",
    mossLight: "#f4f8fb",
    mossShade: "#9cbcd8",
    rock: "#d6e2ec",
    rockShade: "#7e9cbc",
    sun: "#ffffff",
    snow: "#f4f9fc",
  },
};

const DAB_SHARE: Record<LeafShape, number> = {
  blossom: 0.35,
  leaf: 0.4,
  dab: 1,
};

export interface Look {
  season: Season;
  crown: Vector3[];
  crownShape: number;
  crownDabShare: number;
  moss: Vector3[];
  mossShape: number;
  mossDabShare: number;
  ground: Vector3;
  gravel: Vector3;
  rake: Vector3;
  shadow: Vector3;
  bark: Vector3;
  barkShade: Vector3;
  rock: Vector3;
  rockShade: Vector3;
  sun: Vector3;
  snow: number;
  snowColor: Vector3;
}

function hexToVector(hex: string): Vector3 {
  const value = parseInt(hex.slice(1), 16);
  return new Vector3(
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  );
}

export function lookFor(
  season: Season,
  tree: TreeLook,
  sceneOverride: Partial<SceneColors> = {},
): Look {
  const scene = { ...SCENE[season], ...sceneOverride };
  const crown = tree.crown.map(hexToVector);
  const mossLight = hexToVector(scene.mossLight);
  const isAutumn = season === "autumn";
  return {
    season,
    crown,
    crownShape: ATLAS_CELL[tree.leaf],
    crownDabShare: DAB_SHARE[tree.leaf],
    moss: isAutumn
      ? crown
      : [
          hexToVector(scene.mossShade),
          hexToVector(scene.moss),
          mossLight,
          mossLight.clone().lerp(new Vector3(1, 1, 1), 0.3),
        ],
    mossShape: isAutumn ? ATLAS_CELL.leaf : ATLAS_CELL.dab,
    mossDabShare: isAutumn ? 0.45 : 1,
    ground: hexToVector(scene.ground),
    gravel: hexToVector(scene.gravel),
    rake: hexToVector(scene.rake),
    shadow: hexToVector(scene.shadow),
    bark: hexToVector(tree.bark),
    barkShade: hexToVector(tree.barkShade),
    rock: hexToVector(scene.rock),
    rockShade: hexToVector(scene.rockShade),
    sun: hexToVector(scene.sun),
    snow: season === "winter" ? 1 : 0,
    snowColor: hexToVector(scene.snow),
  };
}
