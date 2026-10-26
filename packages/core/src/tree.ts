import type { Season, TreeLook } from "./look.ts";
import { Vector3 } from "./math.ts";
import { createRng, type Rng } from "./rng.ts";

/** A kind of tree: how it grows, and how it looks in each season. */
export interface Species {
  /** Adds the branches and leaves of one tree. The builder's `rng` is seeded from the tree's seed. */
  grow(builder: TreeBuilder): void;
  looks: Record<Season, TreeLook>;
}

export interface Branch {
  points: Vector3[];
  radii: number[];
  along: number[];
  arrival: number[];
  depth: number;
  length: number;
}

export interface Leaf {
  position: Vector3;
  normal: Vector3;
  size: number;
  angle: number;
  rnd: number;
  arrival: number;
  exposure: number;
}

export interface Tree {
  branches: Branch[];
  leaves: Leaf[];
  bounds: { min: Vector3; max: Vector3 };
  crown: Vector3;
}

/** A point along a branch, from {@link station} or {@link tip}. */
export interface Station {
  position: Vector3;
  direction: Vector3;
  radius: number;
  arrival: number;
}

/** The shape of one branch, for {@link TreeBuilder.trunk} and {@link TreeBuilder.sprout}. */
export interface LimbSpec {
  direction: Vector3;
  length: number;
  /** Segments along the branch. Defaults to one per 0.16 of length. */
  steps?: number;
  radiusStart: number;
  radiusEnd: number;
  /** Exponent of the taper from `radiusStart` to `radiusEnd`. Defaults to 1. */
  taper?: number;
  /** Extra width at the base, as a share of the radius. */
  flare?: number;
  /** Random sideways turn at each step. */
  wander?: number;
  /** Downward pull that grows along the branch. */
  droop?: number;
  /** Changes the heading in place at each step, at `t` from 0 to 1 along the branch. */
  bend?: (direction: Vector3, t: number) => void;
}

/** An ellipsoid of leaves, for {@link TreeBuilder.cluster}. */
export interface ClusterSpec {
  center: Vector3;
  radii: Vector3;
  /** Leaves per unit of surface. */
  density: number;
  /** When the leaves start to grow, on the same scale as branch arrival. */
  arrival: number;
}

const TAU = Math.PI * 2;

export function perpendicular(v: Vector3): Vector3 {
  const helper =
    Math.abs(v.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  return helper.cross(v).normalize();
}

/** Turns `direction` by `angle` toward `azimuth` around itself. */
export function tilt(
  direction: Vector3,
  angle: number,
  azimuth: number,
): Vector3 {
  const axis = perpendicular(direction).applyAxisAngle(direction, azimuth);
  return direction.clone().applyAxisAngle(axis, angle).normalize();
}

/** Collects the branches and leaves that a {@link Species} grows. */
export class TreeBuilder {
  readonly branches: Branch[] = [];
  readonly leaves: Leaf[] = [];
  readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  /** A random number from `min` to `max`. */
  range(min: number, max: number): number {
    return min + (max - min) * this.rng();
  }

  /** A random number with a roughly normal spread around 0. */
  gaussian(): number {
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += this.rng();
    return (sum - 2) / 0.577;
  }

  /** A random unit vector. */
  direction(): Vector3 {
    const v = new Vector3(this.gaussian(), this.gaussian(), this.gaussian());
    return v.lengthSq() < 1e-6 ? new Vector3(0, 1, 0) : v.normalize();
  }

  /** Grows a branch from the ground at the origin. */
  trunk(spec: LimbSpec): Branch {
    return this.walk(new Vector3(), spec, 0, 0);
  }

  /** Grows a branch from the point at `t`, from 0 to 1, along `parent`. */
  sprout(parent: Branch, t: number, spec: LimbSpec): Branch {
    const at = station(parent, t);
    return this.walk(
      at.position,
      { ...spec, radiusStart: Math.min(spec.radiusStart, at.radius * 0.92) },
      parent.depth + 1,
      at.arrival + 0.05,
    );
  }

  private walk(
    origin: Vector3,
    spec: LimbSpec,
    depth: number,
    arrivalStart: number,
  ): Branch {
    const steps = Math.max(3, Math.round(spec.steps ?? spec.length / 0.16));
    const stepLength = spec.length / steps;
    const heading = spec.direction.clone().normalize();
    const side = perpendicular(heading);
    const points = [origin.clone()];
    const radii = [spec.radiusStart];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      spec.bend?.(heading, t);
      heading.normalize();
      if (spec.wander) {
        side.applyAxisAngle(heading, 0.9 * this.range(-1, 1)).normalize();
        heading
          .addScaledVector(side, spec.wander * this.range(-0.6, 1))
          .normalize();
      }
      if (spec.droop) heading.y -= spec.droop * t;
      heading.normalize();
      points.push(points[i - 1].clone().addScaledVector(heading, stepLength));
      radii.push(
        spec.radiusStart +
          (spec.radiusEnd - spec.radiusStart) * t ** (spec.taper ?? 1),
      );
    }
    if (spec.flare) {
      for (let i = 0; i < radii.length; i++)
        radii[i] *= 1 + spec.flare * Math.exp(-(i / steps) * 9);
    }
    const along = [0];
    for (let i = 1; i < points.length; i++)
      along.push(along[i - 1] + points[i].distanceTo(points[i - 1]));
    const branch: Branch = {
      points,
      radii,
      along,
      arrival: along.map((d) => arrivalStart + d),
      depth,
      length: along[along.length - 1],
    };
    this.branches.push(branch);
    return branch;
  }

  /** Scatters leaves through an ellipsoid. */
  cluster({ center, radii, density, arrival }: ClusterSpec): void {
    const { x: rx, y: ry, z: rz } = radii;
    const area = (rx * ry + ry * rz + rx * rz) / 3;
    const count = Math.round(2.4 * density * Math.max(0.5, area / 0.3));
    for (let i = 0; i < count; i++) {
      const dir = this.direction();
      const depth = Math.cbrt(this.rng());
      this.leaves.push({
        position: new Vector3(
          dir.x * rx * depth,
          dir.y * ry * depth,
          dir.z * rz * depth,
        ).add(center),
        normal: new Vector3(dir.x / rx, dir.y / ry, dir.z / rz).normalize(),
        size: this.range(0.65, 1.4),
        angle: this.range(0, TAU),
        rnd: this.rng(),
        arrival: arrival + this.range(0, 0.35),
        exposure: depth,
      });
    }
  }
}

/** The point at `t`, from 0 to 1, along `branch`. */
export function station(branch: Branch, t: number): Station {
  const target = t * branch.length;
  let i = 1;
  while (i < branch.along.length - 1 && branch.along[i] < target) i++;
  const span = Math.max(1e-6, branch.along[i] - branch.along[i - 1]);
  const f = (target - branch.along[i - 1]) / span;
  return {
    position: branch.points[i - 1].clone().lerp(branch.points[i], f),
    direction: branch.points[i]
      .clone()
      .sub(branch.points[i - 1])
      .normalize(),
    radius: branch.radii[i - 1] + (branch.radii[i] - branch.radii[i - 1]) * f,
    arrival:
      branch.arrival[i - 1] + (branch.arrival[i] - branch.arrival[i - 1]) * f,
  };
}

/** The end of `branch`. */
export function tip(branch: Branch): Station {
  const n = branch.points.length;
  return {
    position: branch.points[n - 1].clone(),
    direction: branch.points[n - 1]
      .clone()
      .sub(branch.points[n - 2])
      .normalize(),
    radius: branch.radii[n - 1],
    arrival: branch.arrival[n - 1],
  };
}

/** Grows a tree and keeps a `leafDensity` share of its leaves, so the branches stay the same at any density. */
export function growTree(
  species: Species,
  seed: number,
  leafDensity = 1,
): Tree {
  const builder = new TreeBuilder(createRng(Math.imul(0x9e3779b1, seed)));
  species.grow(builder);
  const { branches } = builder;
  const keep = createRng(Math.imul(0x85ebca6b, seed) + 1);
  const leaves =
    leafDensity < 1
      ? builder.leaves.filter(() => keep() < leafDensity)
      : builder.leaves;

  let reach = 0;
  for (const branch of branches)
    reach = Math.max(reach, branch.arrival[branch.arrival.length - 1]);
  for (const leaf of leaves) reach = Math.max(reach, leaf.arrival);
  const scale = 1 / Math.max(1e-6, reach);
  for (const branch of branches)
    branch.arrival = branch.arrival.map((a) => a * scale);
  for (const leaf of leaves) leaf.arrival *= scale;

  const bounds = {
    min: new Vector3(Infinity, Infinity, Infinity),
    max: new Vector3(-Infinity, -Infinity, -Infinity),
  };
  const expand = (p: Vector3) => {
    bounds.min.set(
      Math.min(bounds.min.x, p.x),
      Math.min(bounds.min.y, p.y),
      Math.min(bounds.min.z, p.z),
    );
    bounds.max.set(
      Math.max(bounds.max.x, p.x),
      Math.max(bounds.max.y, p.y),
      Math.max(bounds.max.z, p.z),
    );
  };
  for (const leaf of leaves) expand(leaf.position);
  for (const branch of branches)
    for (const point of branch.points) expand(point);

  const crown = new Vector3();
  for (const leaf of leaves) crown.add(leaf.position);
  crown.multiplyScalar(1 / Math.max(1, leaves.length));

  const half = bounds.max.clone().sub(bounds.min).multiplyScalar(0.5);
  for (const leaf of leaves) {
    const outward = leaf.position.clone().sub(crown);
    outward.x /= Math.max(0.3, half.x);
    outward.y /= Math.max(0.3, half.y);
    outward.z /= Math.max(0.3, half.z);
    leaf.normal
      .multiplyScalar(0.78)
      .addScaledVector(outward.normalize(), 0.22)
      .normalize();
  }

  return { branches, leaves, bounds, crown };
}
