/** Writes a number as a shader float literal. */
export const f = (n: number): string =>
  Number.isInteger(n) ? `${n}.0` : String(n);

/** Floats in the `Camera` uniform. */
export const CAMERA_FLOATS = 24;
/** Floats in the `Frame` uniform. */
export const FRAME_FLOATS = 52;
/** Floats in the `Look` uniform. */
export const LOOK_FLOATS = 80;
/** Floats in the `Draw` uniform. */
export const DRAW_FLOATS = 20;
/** Float offsets of the `Frame` fields that change every frame. */
export const FRAME = {
  shadowMatrix: 0,
  stones: 16,
  time: 40,
  treeHeight: 41,
  grow: 42,
  blow: 43,
  fade: 44,
  stoneCount: 45,
  wipe: 46,
  origin: 48,
  aspect: 50,
} as const;
/** Shadow blur radius in shadow map texels. */
export const SHADOW_RADIUS_TEXELS = 2.2 * 1.4;
