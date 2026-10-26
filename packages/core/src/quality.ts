/** Trades looks for speed on slow GPUs. Every field is optional. */
export interface Quality {
  /**
   * Share of the species' leaves that grow, from 0 to 1. Each leaf grows by
   * `leafDensity ** -0.25`, so a thin crown still looks full. Defaults to 1.
   */
  leafDensity?: number;
  /** Smooths edges with 4x multisampling. Defaults to true. */
  antialias?: boolean;
  /** Width and height of the shadow map in texels, a power of two from 64. Defaults to 2048. */
  shadowSize?: number;
  /** Draws the shadow map once in this many frames. Defaults to 1. */
  shadowInterval?: number;
  /** Shadow map samples for each pixel of ground, bark and stone, from 1 to 16. Defaults to 16. */
  shadowSamples?: number;
  /** Shadow map samples for each pixel of a leaf, from 1 to 16. Defaults to 16. */
  leafShadowSamples?: number;
  /** Most leaves that fall at once. Defaults to 6000. */
  fallingLeaves?: number;
}

export interface Settings extends Required<Quality> {
  leafScale: number;
}

const LEAF_SCALE = 0.16;

function whole(name: string, value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(
      `${name} must be a whole number from ${min} to ${max}`,
    );
  return value;
}

export function settle(quality: Quality = {}): Settings {
  const leafDensity = quality.leafDensity ?? 1;
  if (!(leafDensity > 0 && leafDensity <= 1))
    throw new RangeError("leafDensity must be above 0 and at most 1");
  const shadowSize = quality.shadowSize ?? 2048;
  if (shadowSize < 64 || !Number.isInteger(Math.log2(shadowSize)))
    throw new RangeError("shadowSize must be a power of two from 64");
  return {
    leafDensity,
    antialias: quality.antialias ?? true,
    shadowSize,
    shadowInterval: whole("shadowInterval", quality.shadowInterval ?? 1, 1, 60),
    shadowSamples: whole("shadowSamples", quality.shadowSamples ?? 16, 1, 16),
    leafShadowSamples: whole(
      "leafShadowSamples",
      quality.leafShadowSamples ?? 16,
      1,
      16,
    ),
    fallingLeaves: whole(
      "fallingLeaves",
      quality.fallingLeaves ?? 6000,
      1,
      100_000,
    ),
    leafScale: LEAF_SCALE * leafDensity ** -0.25,
  };
}
