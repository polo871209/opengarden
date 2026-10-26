/// <reference types="@webgpu/types" />
export {
  ATLAS_HEIGHT,
  ATLAS_WIDTH,
  type Paint2D,
  paintLeafAtlas,
} from "./atlas.ts";
export { CONTROLS } from "./controls.ts";
export { createGarden, type Garden, type GardenOptions } from "./garden.ts";
export {
  type LeafShape,
  type SceneColors,
  SEASONS,
  type Season,
  type TreeLook,
} from "./look.ts";
export type { Image } from "./renderer.ts";
export type { Rng } from "./rng.ts";
export {
  type Branch,
  type ClusterSpec,
  type Leaf,
  type LimbSpec,
  type Species,
  type Station,
  station,
  TreeBuilder,
  tilt,
  tip,
} from "./tree.ts";
