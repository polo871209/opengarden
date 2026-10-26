import { Vector3 } from "./math.ts";
import type { Rng } from "./rng.ts";
import { type MoundShape, moundHeight } from "./world.ts";

const DRAG = 2.4;
const DEAD = -1e9;

/** Floats per falling leaf: start 3, velocity 3, terminal 3, timing 4, look 4. */
export const FALL_FLOATS = 17;
const TIMING = 9;
const LOOK = 13;

export type FallKind = "knocked" | "petal" | "snow";

const KIND_CODE: Record<FallKind, number> = { knocked: 0, petal: 1, snow: 2 };

export type Launch = {
  start: Vector3;
  velocity: Vector3;
  terminal: Vector3;
  size: number;
  rnd: number;
  kind: FallKind;
} & ({ restTime: number } | { lifetime: number });

interface Landing {
  time: number;
  x: number;
  z: number;
}

function solveLanding(mound: MoundShape, launch: Launch): Landing {
  const { start, velocity, terminal } = launch;
  const at = (t: number) => {
    const e = (1 - Math.exp(-DRAG * t)) / DRAG;
    return [
      start.x + velocity.x * e + terminal.x * (t - e),
      start.y + velocity.y * e + terminal.y * (t - e),
      start.z + velocity.z * e + terminal.z * (t - e),
    ];
  };
  let time = Math.max(
    0.1,
    (start.y - moundHeight(mound, start.x, start.z)) / -terminal.y + 0.4,
  );
  for (let i = 0; i < 6; i++) {
    const [x, y, z] = at(time);
    const above = y - moundHeight(mound, x, z) - 0.02;
    const decay = Math.exp(-DRAG * time);
    const fallRate = velocity.y * decay + terminal.y * (1 - decay);
    time = Math.max(0, time - above / Math.min(fallRate, -0.05));
  }
  const [x, , z] = at(time);
  return { time, x, z };
}

export class FallingLeaves {
  /** {@link FALL_FLOATS} floats per leaf, in the layout the fall shader reads. */
  readonly instances: Float32Array<ArrayBuffer>;
  private readonly capacity: number;
  private readonly mound: MoundShape;
  private readonly rng: Rng;
  private readonly restX: Float32Array;
  private readonly restZ: Float32Array;
  private readonly restFrom: Float32Array;
  private readonly restUntil: Float32Array;
  private next = 0;
  private dirtyFrom = 0;
  private dirtyTo = 0;

  constructor(capacity: number, mound: MoundShape, rng: Rng) {
    this.capacity = capacity;
    this.mound = mound;
    this.rng = rng;
    this.instances = new Float32Array(capacity * FALL_FLOATS);
    this.restX = new Float32Array(capacity);
    this.restZ = new Float32Array(capacity);
    this.restFrom = new Float32Array(capacity);
    this.restUntil = new Float32Array(capacity);
    this.clear();
  }

  launch(launch: Launch, now: number): void {
    const slot = this.next;
    this.next = (this.next + 1) % this.capacity;
    const landing = solveLanding(this.mound, launch);
    const rest =
      "lifetime" in launch ? launch.lifetime - landing.time : launch.restTime;
    this.instances.set(
      [
        ...launch.start.toArray(),
        ...launch.velocity.toArray(),
        ...launch.terminal.toArray(),
        now,
        landing.time,
        rest,
        this.rng(),
        launch.size,
        1.2 + 2.8 * this.rng(),
        launch.rnd,
        KIND_CODE[launch.kind],
      ],
      slot * FALL_FLOATS,
    );
    this.restX[slot] = landing.x;
    this.restZ[slot] = landing.z;
    const sweepable = launch.kind === "knocked";
    this.restFrom[slot] = sweepable ? now + landing.time : DEAD;
    this.restUntil[slot] = sweepable ? now + landing.time + rest - 2.5 : DEAD;
    this.markDirty(slot, slot + 1);
  }

  sweep(
    center: Vector3,
    radius: number,
    push: Vector3,
    limit: number,
    now: number,
    relaunch: (
      from: Vector3,
      velocity: Vector3,
      size: number,
      rnd: number,
    ) => void,
  ): number {
    const r2 = radius * radius;
    let moved = 0;
    for (let i = 0; i < this.capacity && moved < limit; i++) {
      if (now < this.restFrom[i] + 0.15 || now > this.restUntil[i]) continue;
      const dx = this.restX[i] - center.x;
      const dz = this.restZ[i] - center.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const closeness = 1 - Math.sqrt(d2) / radius;
      const away = new Vector3(dx, 0, dz)
        .normalize()
        .multiplyScalar(0.6 * closeness);
      const velocity = push
        .clone()
        .multiplyScalar(0.6 + closeness)
        .add(away)
        .add(new Vector3(0, 0.9 + 1.4 * closeness + 0.6 * this.rng(), 0));
      const from = new Vector3(
        this.restX[i],
        moundHeight(this.mound, this.restX[i], this.restZ[i]) + 0.05,
        this.restZ[i],
      );
      const size = this.instances[i * FALL_FLOATS + LOOK];
      const rnd = this.instances[i * FALL_FLOATS + LOOK + 2];
      this.instances[i * FALL_FLOATS + TIMING] = DEAD;
      this.restFrom[i] = DEAD;
      this.restUntil[i] = DEAD;
      this.markDirty(i, i + 1);
      relaunch(from, velocity, size, rnd);
      moved++;
    }
    return moved;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++)
      this.instances[i * FALL_FLOATS + TIMING] = DEAD;
    this.restFrom.fill(DEAD);
    this.restUntil.fill(DEAD);
    this.markDirty(0, this.capacity);
  }

  flush(
    upload: (changed: Float32Array<ArrayBuffer>, firstLeaf: number) => void,
  ): void {
    if (this.dirtyFrom >= this.dirtyTo) return;
    upload(
      this.instances.subarray(
        this.dirtyFrom * FALL_FLOATS,
        this.dirtyTo * FALL_FLOATS,
      ),
      this.dirtyFrom,
    );
    this.dirtyFrom = this.capacity;
    this.dirtyTo = 0;
  }

  private markDirty(from: number, to: number): void {
    this.dirtyFrom = Math.min(this.dirtyFrom, from);
    this.dirtyTo = Math.max(this.dirtyTo, to);
  }
}
