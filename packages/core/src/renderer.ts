import type { Look } from "./look.ts";
import { LEAF_FLOATS, type Mesh } from "./meshes.ts";
import type { Settings } from "./quality.ts";

const SORT_BUCKETS = 4096;

/** RGBA pixels, 4 bytes each, rows top first. */
export interface Image {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>;
}

export interface Solid {
  mesh: Mesh;
  /** Column-major model matrix. */
  model: ArrayLike<number>;
  variant: number;
}

export interface SceneSetup {
  atlas: Image;
  /** {@link LEAF_FLOATS} floats per moss leaf. */
  moss: Float32Array<ArrayBuffer>;
  solids: Solid[];
  settings: Settings;
}

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface FrameState {
  frame: Float32Array<ArrayBuffer>;
  eye: Float32Array<ArrayBuffer>;
  sun: Float32Array<ArrayBuffer>;
  viewer: Point;
  current: Look;
  incoming: Look | null;
}

/** Draws the garden. `Target` is what each backend draws into. */
export interface Renderer<Target extends unknown[]> {
  resize(width: number, height: number): void;
  setTree(bark: Mesh, leaves: Float32Array<ArrayBuffer>): void;
  setGone(gone: Float32Array<ArrayBuffer>): void;
  setFalling(changed: Float32Array<ArrayBuffer>, firstLeaf: number): void;
  render(state: FrameState, ...target: Target): void;
  dispose(): void;
}

const vec4 = (v: Point) => [v.x, v.y, v.z, 0];

export function packLook(look: Look, out: Float32Array, at: number): void {
  out.set(
    [
      ...look.crown.flatMap(vec4),
      ...look.moss.flatMap(vec4),
      ...[
        look.ground,
        look.gravel,
        look.rake,
        look.shadow,
        look.bark,
        look.barkShade,
        look.rock,
        look.rockShade,
        look.sun,
        look.snowColor,
      ].flatMap(vec4),
      look.crownShape,
      look.crownDabShare,
      look.mossShape,
      look.mossDabShare,
      look.snow,
    ],
    at,
  );
}

export function mipLevels(image: Image): Image[] {
  const levels = [image];
  let level = image;
  while (level.width > 1 || level.height > 1) {
    const width = Math.max(1, level.width >> 1);
    const height = Math.max(1, level.height >> 1);
    const data = new Uint8Array(width * height * 4);
    const at = (x: number, y: number, c: number) =>
      level.data[
        (Math.min(y, level.height - 1) * level.width +
          Math.min(x, level.width - 1)) *
          4 +
          c
      ];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 4; c++)
          data[(y * width + x) * 4 + c] =
            (at(2 * x, 2 * y, c) +
              at(2 * x + 1, 2 * y, c) +
              at(2 * x, 2 * y + 1, c) +
              at(2 * x + 1, 2 * y + 1, c) +
              2) >>
            2;
    level = { width, height, data };
    levels.push(level);
  }
  return levels;
}

/** The leaf indices in order of `distance`, nearest first. */
export function nearestFirst(
  leaves: Float32Array,
  distance: (x: number, y: number, z: number) => number,
): Uint32Array<ArrayBuffer> {
  const count = leaves.length / LEAF_FLOATS;
  const distances = new Float64Array(count);
  let near = Infinity;
  let far = -Infinity;
  for (let i = 0; i < count; i++) {
    const at = i * LEAF_FLOATS;
    const d = distance(leaves[at], leaves[at + 1], leaves[at + 2]);
    distances[i] = d;
    near = Math.min(near, d);
    far = Math.max(far, d);
  }
  const scale = (SORT_BUCKETS - 1) / Math.max(far - near, 1e-9);
  const buckets = new Uint16Array(count);
  const starts = new Uint32Array(SORT_BUCKETS + 1);
  for (let i = 0; i < count; i++) {
    buckets[i] = Math.floor((distances[i] - near) * scale);
    starts[buckets[i] + 1]++;
  }
  for (let b = 1; b <= SORT_BUCKETS; b++) starts[b] += starts[b - 1];
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[starts[buckets[i]]++] = i;
  return order;
}

export const fromViewer =
  (viewer: Point) =>
  (x: number, y: number, z: number): number =>
    (x - viewer.x) ** 2 + (y - viewer.y) ** 2 + (z - viewer.z) ** 2;

/** Counts frames and says when the shadow map is due. */
export function shadowClock(settings: Settings): {
  due(): boolean;
  invalidate(): void;
} {
  let frame = 0;
  let fresh = false;
  return {
    due() {
      const due = !fresh || frame % settings.shadowInterval === 0;
      frame++;
      fresh = true;
      return due;
    },
    invalidate() {
      fresh = false;
    },
  };
}
