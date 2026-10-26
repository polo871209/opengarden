import {
  type Species,
  station,
  type TreeBuilder,
  tilt,
  tip,
  Vector3,
} from "@opengardenjs/core";

const TAU = Math.PI * 2;
const LEAVES = 54;

function ellipsoid(r: number, flat: number): Vector3 {
  return new Vector3(r * 1.1, r * flat, r * 1.1);
}

function grow(b: TreeBuilder): void {
  const trunk = b.trunk({
    direction: new Vector3(b.range(-0.06, 0.06), 1, b.range(-0.06, 0.06)),
    length: 1.45,
    radiusStart: 0.17,
    radiusEnd: 0.12,
    wander: 0.05,
    flare: 0.5,
    steps: 7,
  });
  const limbCount = b.rng() < 0.5 ? 5 : 4;
  const phase = b.range(0, TAU);
  for (let i = 0; i < limbCount; i++) {
    const azimuth = phase + (i / limbCount) * TAU + b.range(-0.3, 0.3);
    const direction = tilt(tip(trunk).direction, b.range(0.45, 0.9), azimuth);
    const limbLength = b.range(2, 2.6);
    const limb = b.sprout(trunk, b.range(0.88, 1), {
      direction,
      length: limbLength,
      radiusStart: 0.11,
      radiusEnd: 0.035,
      wander: 0.09,
      taper: 0.8,
      bend: (heading, t) => {
        const outward = new Vector3(heading.x, 0, heading.z).normalize();
        heading.addScaledVector(outward, 0.06);
        heading.y += t > 0.55 ? -0.07 : 0.02;
      },
    });
    const sideCount = 3 + Math.floor(b.range(0, 2));
    for (let j = 0; j < sideCount; j++) {
      const at = Math.min(
        0.98,
        0.38 + (j / sideCount) * 0.6 + b.range(-0.05, 0.05),
      );
      const side = b.sprout(limb, at, {
        direction: tilt(
          station(limb, at).direction,
          b.range(0.45, 0.9),
          b.range(0, 6.28),
        ),
        length: limbLength * b.range(0.38, 0.55),
        radiusStart: 0.05,
        radiusEnd: 0.015,
        wander: 0.14,
        droop: 0.04,
      });
      const twigCount = 2 + Math.floor(b.range(0, 2));
      for (let k = 0; k < twigCount; k++) {
        const twig = b.sprout(side, b.range(0.45, 0.95), {
          direction: tilt(
            side.points[1].clone().sub(side.points[0]).normalize(),
            b.range(0.5, 1),
            b.range(0, 6.28),
          ),
          length: limbLength * b.range(0.18, 0.28),
          radiusStart: 0.025,
          radiusEnd: 0.009,
          wander: 0.2,
          steps: 3,
        });
        const r = b.range(0.55, 0.78);
        b.cluster({
          center: tip(twig).position.add(
            new Vector3(0, b.range(-0.1, 0.35), 0),
          ),
          radii: new Vector3(1.05 * r, 0.82 * r, 1.05 * r),
          density: LEAVES,
          arrival: tip(twig).arrival,
        });
      }
      const end = tip(side);
      b.cluster({
        center: end.position,
        radii: ellipsoid(b.range(0.62, 0.85), 0.85),
        density: LEAVES,
        arrival: end.arrival,
      });
    }
    const end = tip(limb);
    const r = 0.95;
    b.cluster({
      center: end.position,
      radii: ellipsoid(r, 0.8),
      density: LEAVES,
      arrival: end.arrival,
    });
    const upper = station(limb, 0.72);
    b.cluster({
      center: upper.position.add(new Vector3(0, 0.35, 0)),
      radii: new Vector3(0.9 * r, 0.7 * r, 0.9 * r),
      density: 40,
      arrival: upper.arrival,
    });
  }
}

/** A cherry tree: blossom in spring, green in summer, orange in autumn, snow in winter. */
export const cherry: Species = {
  grow,
  looks: {
    spring: {
      crown: ["#ad78bc", "#d986aa", "#f0a0b0", "#f9c3c6"],
      leaf: "blossom",
      bark: "#b8a8c4",
      barkShade: "#7f86aa",
    },
    summer: {
      crown: ["#1f7a72", "#2f9278", "#56b383", "#a6e0a8"],
      leaf: "leaf",
      bark: "#7a6a64",
      barkShade: "#4f5a6e",
    },
    autumn: {
      crown: ["#d2502a", "#ee7a2c", "#f4a43c", "#f6d466"],
      leaf: "leaf",
      bark: "#885135",
      barkShade: "#5a3a3c",
    },
    winter: {
      crown: ["#6f9cd0", "#a8c6e4", "#e4f0f6", "#ffffff"],
      leaf: "dab",
      bark: "#5d6f86",
      barkShade: "#3a4c68",
    },
  },
};
