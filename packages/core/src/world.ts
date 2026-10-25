export const WIND = 0.5;
export const WIND_SPEED = 1;
export const WIND_DIR: readonly [number, number] = (() => {
  const length = Math.hypot(-0.94, -0.34);
  return [-0.94 / length, -0.34 / length];
})();
export const GROW_WIDTH = 0.12;
export const REGROW_AFTER = 18;
export const LEAF_SCALE = 0.16;
export const SHADOW_SIZE = 2048;

export interface MoundShape {
  radius: number;
  height: number;
}

export const MOUND: MoundShape = { radius: 1.8, height: 0.32 };

export function moundHeight(mound: MoundShape, x: number, z: number): number {
  const r = Math.hypot(x, z) / mound.radius;
  return r < 1 ? mound.height * (1 - r * r) ** 1.3 : 0;
}

const SUN_TURN = (62 * Math.PI) / 180;
const SUN_HEIGHT = (19 * Math.PI) / 180;
export const SUN_DIR: readonly [number, number, number] = [
  Math.sin(SUN_TURN) * Math.cos(SUN_HEIGHT),
  Math.sin(SUN_HEIGHT),
  Math.cos(SUN_TURN) * Math.cos(SUN_HEIGHT),
];
