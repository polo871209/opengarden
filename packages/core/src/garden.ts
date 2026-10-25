import {
  type Camera,
  MathUtils,
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  Raycaster,
  Vector2,
  Vector3,
  WebGPUCoordinateSystem,
} from "three";
import { FallingLeaves, type FallKind } from "./falling.ts";
import { type Look, lookFor, type Season } from "./look.ts";
import {
  createBarkMesh,
  createLeafInstances,
  createMoundMesh,
  NEVER,
  placeStones,
  scatterMoss,
} from "./meshes.ts";
import { createRenderer, type Image } from "./renderer.ts";
import { createRng } from "./rng.ts";
import { CAMERA_FLOATS, FRAME, FRAME_FLOATS } from "./shaders.ts";
import { growTree, type Species, type Tree } from "./tree.ts";
import {
  MOUND,
  moundHeight,
  REGROW_AFTER,
  SUN_DIR,
  WIND,
  WIND_DIR,
  WIND_SPEED,
} from "./world.ts";

const REST_TIME = 60;
const AMBIENT_PER_SECOND = 15.5;
const AMBIENT_WARMUP = 12;
const GROW_TIME = 1.7;
const BLOW_TIME = 0.55;
const WIPE_TIME = 0.85;
const TILT = 11;
const FALL_CAPACITY = 6000;
const STEP_SECONDS = 1 / 60;

export interface GardenOptions {
  species: Species;
  seed?: number;
  season?: Season;
  /** The leaf shapes that `paintLeafAtlas` paints. */
  atlas: Image;
}

/**
 * The garden simulation and its WebGPU renderer, with no DOM. Positions are
 * CSS pixels from the top left of the rendered image.
 */
export interface Garden {
  readonly season: Season;
  /** True if the pointer is over leaves that it can knock down. */
  readonly overLeaves: boolean;
  setSeason(season: Season): void;
  newTree(seed?: number): void;
  /** Sets the size of the render target, and how many of its pixels make one CSS pixel. */
  resize(width: number, height: number, pixelRatio: number): void;
  /** Moves time forward by one step of `seconds`. */
  update(seconds: number): void;
  /** Moves time forward by `seconds`, in steps of at most 1/60 second. */
  advance(seconds: number): void;
  /**
   * Renders into a texture of the format that the garden was created with.
   * Records into `encoder` if there is one, and submits its own commands if not.
   */
  render(target: GPUTextureView, encoder?: GPUCommandEncoder): void;
  pointerDown(x: number, y: number, touch: boolean): void;
  pointerMove(x: number, y: number): void;
  /** `cancelled` is true if the press ended without a release, so it is not a click. */
  pointerUp(x: number, y: number, cancelled: boolean): void;
  /** Moves through the garden by `dx`, `dy` in `seconds`, as a pointer does. */
  brush(x: number, y: number, dx: number, dy: number, seconds: number): void;
  /** Clicks the garden. */
  gust(x: number, y: number): void;
  reset(): void;
  dispose(): void;
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function packCamera(camera: Camera, out: Float32Array): Float32Array {
  new Matrix4()
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .toArray(out, 0);
  new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).toArray(out, 16);
  new Vector3().setFromMatrixColumn(camera.matrixWorld, 1).toArray(out, 20);
  return out;
}

export function createGarden(
  device: GPUDevice,
  format: GPUTextureFormat,
  options: GardenOptions,
): Garden {
  const windDir = new Vector2(...WIND_DIR);
  const camera = new PerspectiveCamera(30, 1, 0.1, 200);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  const sunCamera = new OrthographicCamera(-8.5, 8.5, 8.5, -8.5, 1, 60);
  sunCamera.coordinateSystem = WebGPUCoordinateSystem;
  sunCamera.updateProjectionMatrix();

  const gardenRng = createRng(7919 * (options.seed ?? 7) + 13);
  const moss = createLeafInstances(scatterMoss(MOUND, gardenRng, 2400));
  const stones = placeStones(MOUND, gardenRng, 3);
  const renderer = createRenderer(device, format, {
    atlas: options.atlas,
    moss,
    solids: [
      {
        mesh: createMoundMesh(MOUND),
        model: new Matrix4().elements,
        variant: 0,
      },
      ...stones.map((stone) => ({
        mesh: stone.mesh,
        model: stone.model.elements,
        variant: 1,
      })),
    ],
    fallCapacity: FALL_CAPACITY,
  });

  const frame = new Float32Array(FRAME_FLOATS);
  for (const [i, stone] of stones.entries())
    stone.footprint.toArray(frame, FRAME.stones + 4 * i);
  frame[FRAME.stoneCount] = stones.length;
  const eyeData = new Float32Array(CAMERA_FLOATS);
  const sunData = new Float32Array(CAMERA_FLOATS);

  let seed = options.seed ?? 7;
  let tree: Tree;
  let gone = new Float32Array(0);
  let goneDirty = false;
  let treeHeight = 5;
  let grow = 0;
  let blowAmount = 0;
  let fade = 0;

  const buildTree = () => {
    tree = growTree(options.species, seed);
    renderer.setTree(createBarkMesh(tree), createLeafInstances(tree.leaves));
    gone = new Float32Array(tree.leaves.length).fill(NEVER);
    goneDirty = false;
    treeHeight = Math.max(2, tree.bounds.max.y);
  };
  buildTree();

  const falling = new FallingLeaves(FALL_CAPACITY, MOUND, createRng(777));

  let season: Season = options.season ?? "spring";
  const lookOf = (next: Season) => lookFor(next, options.species.looks[next]);
  let current = lookOf(season);
  let incoming: Look | null = null;
  let wipe = 0;

  let time = 0;
  let growth = 0;
  let growing = true;
  let blowing = false;
  let blow = 0;
  let ambientDebt = 0;
  let primed = false;
  const ambientRng = createRng(4242);

  let spin = 0;
  let spinVelocity = 0;
  let tiltOffset = 0;
  let cssWidth = 1;
  let cssHeight = 1;
  let overLeaves = false;

  const isGone = (i: number) =>
    time - gone[i] >= 0 && time - gone[i] < REGROW_AFTER;

  const windOffset = (p: Vector3): Vector3 => {
    const h = Math.max(p.y - 0.25, 0) / Math.max(treeHeight, 0.5);
    const bend = h * h * WIND;
    const t = time * WIND_SPEED;
    const sway = 0.55 + 0.45 * Math.sin(0.9 * t + 0.22 * p.x + 0.17 * p.z);
    const gust =
      0.5 + 0.5 * Math.sin(0.31 * t + 1.7) * Math.sin(0.53 * t + 0.4);
    const along = bend * (0.18 + 0.32 * sway * (0.6 + 0.8 * gust));
    const across = bend * 0.08 * Math.sin(1.7 * t + 0.9 * p.y + p.x);
    return new Vector3(
      windDir.x * along - windDir.y * across,
      -bend * 0.05 * (0.5 + 0.5 * Math.sin(1.1 * t + p.z)),
      windDir.y * along + windDir.x * across,
    );
  };

  const terminalVelocity = (kind: FallKind) => {
    const r = ambientRng;
    const winter = current.season === "winter";
    const drift = (kind === "knocked" ? 0.45 : 0.55) + 0.6 * r();
    const speed =
      kind === "knocked"
        ? (winter ? 0.4 : 0.62) * (0.75 + 0.5 * r())
        : (kind === "snow" ? 0.35 : 0.55) * (0.7 + 0.6 * r());
    return new Vector3(
      windDir.x * drift * (0.4 + WIND),
      -speed,
      windDir.y * drift * (0.4 + WIND),
    );
  };

  const drop = (start: Vector3, velocity: Vector3, size: number, rnd: number) =>
    falling.launch(
      {
        start,
        velocity,
        terminal: terminalVelocity("knocked"),
        size,
        rnd,
        kind: "knocked",
        restTime: REST_TIME,
      },
      time,
    );

  const spawnAmbient = (count: number, backdate = 0) => {
    const kind: FallKind = season === "winter" ? "snow" : "petal";
    for (let n = 0; n < count; n++) {
      const at = time - backdate * ambientRng();
      const lifetime = 6 + 6 * ambientRng();
      if (kind === "snow") {
        falling.launch(
          {
            start: new Vector3(
              (ambientRng() - 0.3) * 14,
              6 + 3 * ambientRng(),
              (ambientRng() - 0.5) * 10,
            ),
            velocity: new Vector3(),
            terminal: terminalVelocity(kind),
            size: 0.55 * (0.85 + 0.5 * ambientRng()),
            rnd: ambientRng(),
            kind,
            lifetime,
          },
          at,
        );
        continue;
      }
      const index = Math.floor(ambientRng() * tree.leaves.length);
      if (isGone(index)) continue;
      const leaf = tree.leaves[index];
      falling.launch(
        {
          start: leaf.position.clone().add(windOffset(leaf.position)),
          velocity: new Vector3(),
          terminal: terminalVelocity(kind),
          size: 0.85 + 0.5 * ambientRng(),
          rnd: ambientRng(),
          kind,
          lifetime,
        },
        at,
      );
    }
  };

  const knock = (
    center: Vector3,
    radius: number,
    count: number,
    push: Vector3,
  ) => {
    if (count <= 0) return 0;
    const r2 = radius * radius;
    const candidates: number[] = [];
    tree.leaves.forEach((leaf, i) => {
      if (!isGone(i) && leaf.position.distanceToSquared(center) < r2)
        candidates.push(i);
    });
    let dropped = 0;
    while (dropped < count && candidates.length) {
      const pick = Math.floor(ambientRng() * candidates.length);
      const index = candidates[pick];
      candidates[pick] = candidates[candidates.length - 1];
      candidates.pop();
      const leaf = tree.leaves[index];
      const velocity = push
        .clone()
        .multiplyScalar(0.5 + 0.8 * ambientRng())
        .add(
          new Vector3(
            (ambientRng() - 0.5) * 0.9,
            0.7 * ambientRng(),
            (ambientRng() - 0.5) * 0.9,
          ),
        );
      drop(
        leaf.position.clone().add(windOffset(leaf.position)),
        velocity,
        leaf.size,
        leaf.rnd,
      );
      gone[index] = time;
      dropped++;
    }
    if (dropped) goneDirty = true;
    return dropped;
  };

  const sweep = (
    center: Vector3,
    radius: number,
    push: Vector3,
    limit: number,
  ) => falling.sweep(center, radius, push, limit, time, drop);

  const raycaster = new Raycaster();
  const pointer = new Vector2();

  const aim = (x: number, y: number) => {
    pointer.set((x / cssWidth) * 2 - 1, -(y / cssHeight) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);
  };

  const hitLeaf = (): Vector3 | null => {
    const { origin, direction } = raycaster.ray;
    const reach = 0.24;
    const reach2 = reach * reach;
    let nearest = Infinity;
    let hit: Vector3 | null = null;
    tree.leaves.forEach((leaf, i) => {
      if (isGone(i)) return;
      const dx = leaf.position.x - origin.x;
      const dy = leaf.position.y - origin.y;
      const dz = leaf.position.z - origin.z;
      const along = dx * direction.x + dy * direction.y + dz * direction.z;
      if (along <= 0 || along >= nearest) return;
      if (dx * dx + dy * dy + dz * dz - along * along < reach2) {
        nearest = along;
        hit = leaf.position;
      }
    });
    return hit ? (hit as Vector3).clone() : null;
  };

  const hitGround = (): Vector3 | null => {
    const { origin, direction } = raycaster.ray;
    if (direction.y > -0.01) return null;
    let y = 0;
    let point: Vector3 | null = null;
    for (let i = 0; i < 3; i++) {
      point = origin
        .clone()
        .addScaledVector(direction, (y - origin.y) / direction.y);
      y = moundHeight(MOUND, point.x, point.z);
    }
    return point;
  };

  const screenDirection = (dx: number, dy: number, fallback: Vector3) => {
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const dir = right.multiplyScalar(dx).addScaledVector(up, -dy);
    if (dir.lengthSq() < 1e-6) dir.copy(fallback);
    return dir.normalize().addScaledVector(fallback, 0.35).normalize();
  };

  let lastKnock = -1;
  const lastKnockAt = new Vector3(0, -99, 0);
  let lastSweep = -1;

  const brush = (
    x: number,
    y: number,
    dx: number,
    dy: number,
    seconds: number,
  ) => {
    if (growing || blowing) return;
    aim(x, y);
    const hit = hitLeaf();
    const speed = Math.hypot(dx, dy) / Math.max(seconds, 1 / 240);
    overLeaves = hit !== null;
    if (!hit) {
      const spot = hitGround();
      if (spot && speed > 40 && time - lastSweep > 0.03) {
        const push = screenDirection(
          dx,
          dy,
          raycaster.ray.direction.clone().setY(0).normalize(),
        );
        push.y = 0;
        push.normalize().multiplyScalar(Math.min(2.6, speed / 600));
        if (sweep(spot, 0.42, push, 14)) lastSweep = time;
      }
      return;
    }
    if (time - lastKnock < 0.05 && hit.distanceTo(lastKnockAt) < 0.35) return;
    lastKnock = time;
    lastKnockAt.copy(hit);
    const push = screenDirection(dx, dy, raycaster.ray.direction);
    const count = 6 * MathUtils.clamp(speed / 500, 0.7, 3);
    knock(
      hit,
      0.75,
      Math.floor(count + ambientRng()),
      push.multiplyScalar(Math.min(3, 0.4 + speed / 700)),
    );
  };

  const gust = (x: number, y: number) => {
    if (growing || blowing) return;
    aim(x, y);
    const hit = hitLeaf();
    const windward = new Vector3(windDir.x, 0.25, windDir.y).normalize();
    if (!hit) {
      const spot = hitGround();
      if (spot)
        sweep(
          spot,
          1.1,
          windward.clone().setY(0).normalize().multiplyScalar(1.6),
          120,
        );
    }
    const center = hit ?? tree.crown.clone();
    const facing = hit
      ? raycaster.ray.direction.clone()
      : tree.crown.clone().sub(camera.position).normalize();
    knock(
      center,
      1.7,
      90,
      windward.multiplyScalar(0.6).add(facing).normalize().multiplyScalar(2.4),
    );
  };

  let press: {
    x: number;
    y: number;
    moved: boolean;
    onLeaves: boolean;
  } | null = null;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let lastMoveAt = 0;

  const setSeason = (next: Season) => {
    if (next === season) return;
    const snowChanges = (next === "winter") !== (season === "winter");
    if (incoming) current = incoming;
    season = next;
    incoming = lookOf(next);
    wipe = 0;
    if (primed && snowChanges)
      spawnAmbient(AMBIENT_PER_SECOND * AMBIENT_WARMUP, AMBIENT_WARMUP);
  };

  const update = (dt: number) => {
    time += dt;
    if (!dragging) {
      spin += spinVelocity;
      spinVelocity *= 0.9;
      if (Math.abs(spinVelocity) < 0.001) spinVelocity = 0;
    }
    if (blowing) {
      blow += dt / BLOW_TIME;
      blowAmount = Math.min(1, blow);
      grow = Math.max(
        0,
        1 - easeInOutCubic(MathUtils.clamp((blow - 0.3) / 0.62, 0, 1)),
      );
      if (blow >= 1) {
        blowing = false;
        buildTree();
        falling.clear();
        primed = false;
        blowAmount = 0;
        growth = 0;
        growing = true;
      }
    } else if (growing) {
      growth = Math.min(1, growth + dt / GROW_TIME);
      if (growth >= 1) growing = false;
      grow = 1 - (1 - growth) ** 1.8;
    }
    if (!primed && !blowing && growth >= 0.7) {
      spawnAmbient(AMBIENT_PER_SECOND * AMBIENT_WARMUP, AMBIENT_WARMUP);
      primed = true;
    }
    fade = blowing
      ? Math.max(0, 1 - 2 * blow)
      : MathUtils.clamp((growth - 0.7) / 0.3, 0, 1);
    if (incoming) {
      wipe += dt / WIPE_TIME;
      if (wipe >= 1) {
        current = incoming;
        incoming = null;
        wipe = 0;
      }
    }
    if (primed && !blowing) {
      ambientDebt += dt * AMBIENT_PER_SECOND;
      const count = Math.floor(ambientDebt);
      ambientDebt -= count;
      spawnAmbient(count);
    }
  };

  const placeCameras = () => {
    const turn = MathUtils.degToRad(spin);
    const tilt = MathUtils.degToRad(TILT + tiltOffset);
    const height = Math.max(3.5, tree.bounds.max.y);
    const width = Math.max(
      tree.bounds.max.x - tree.bounds.min.x,
      tree.bounds.max.z - tree.bounds.min.z,
    );
    const halfFov = MathUtils.degToRad(camera.fov) / 2;
    const distance = Math.max(
      (1.75 * height + 1.4) / 2 / Math.tan(halfFov),
      (1.65 * width + 2.4) / 2 / Math.tan(halfFov) / camera.aspect,
      11,
    );
    const target = new Vector3(0, 0.46 * height, 0);
    camera.position.set(
      Math.sin(turn) * Math.cos(tilt) * distance,
      target.y + Math.sin(tilt) * distance,
      Math.cos(turn) * Math.cos(tilt) * distance,
    );
    camera.lookAt(target);
    camera.updateMatrixWorld();

    const sunDir = new Vector3(...SUN_DIR);
    const focus = new Vector3(0, 2.5, 0);
    sunCamera.position.copy(focus).addScaledVector(sunDir, 25);
    sunCamera.lookAt(focus);
    sunCamera.updateMatrixWorld();
  };

  const render = (target: GPUTextureView, encoder?: GPUCommandEncoder) => {
    placeCameras();
    packCamera(camera, eyeData);
    packCamera(sunCamera, sunData);
    frame.set(sunData.subarray(0, 16), FRAME.shadowMatrix);
    frame[FRAME.time] = time;
    frame[FRAME.treeHeight] = treeHeight;
    frame[FRAME.grow] = grow;
    frame[FRAME.blow] = blowAmount;
    frame[FRAME.fade] = fade;
    frame[FRAME.wipe] = easeInOutCubic(Math.min(1, wipe));
    const origin = new Vector3().project(camera);
    frame[FRAME.origin] = 0.5 * origin.x + 0.5;
    frame[FRAME.origin + 1] = 0.5 * origin.y + 0.5;
    frame[FRAME.aspect] = camera.aspect;
    if (goneDirty) {
      renderer.setGone(gone);
      goneDirty = false;
    }
    falling.flush(renderer.setFalling);
    renderer.render(
      target,
      {
        frame,
        eye: eyeData,
        sun: sunData,
        viewer: camera.position,
        current,
        incoming,
      },
      encoder,
    );
  };

  return {
    get season() {
      return season;
    },
    get overLeaves() {
      return overLeaves;
    },
    setSeason,
    newTree(nextSeed) {
      if (blowing) return;
      seed = nextSeed ?? 1 + Math.floor(Math.random() * 999);
      blowing = true;
      blow = 0;
      sweep(
        new Vector3(),
        60,
        new Vector3(windDir.x, 0, windDir.y).multiplyScalar(4.5),
        FALL_CAPACITY,
      );
    },
    resize(width, height, pixelRatio) {
      cssWidth = width / pixelRatio;
      cssHeight = height / pixelRatio;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.resize(width, height);
    },
    update,
    advance(seconds) {
      const steps = Math.max(1, Math.round(seconds / STEP_SECONDS));
      for (let i = 0; i < steps; i++) update(seconds / steps);
    },
    render,
    pointerDown(x, y, touch) {
      lastX = x;
      lastY = y;
      lastMoveAt = performance.now();
      let onLeaves = false;
      if (touch && !growing && !blowing) {
        aim(x, y);
        onLeaves = hitLeaf() !== null;
      }
      press = { x, y, moved: false, onLeaves };
    },
    pointerMove(x, y) {
      const now = performance.now();
      const dx = x - lastX;
      const dy = y - lastY;
      const seconds = (now - lastMoveAt) / 1000;
      lastX = x;
      lastY = y;
      lastMoveAt = now;
      if (press && !press.moved && Math.hypot(x - press.x, y - press.y) > 6) {
        press.moved = true;
        dragging = !press.onLeaves;
      }
      if (dragging) {
        spin -= 0.3 * dx;
        spinVelocity = -0.3 * dx;
        tiltOffset = MathUtils.clamp(
          tiltOffset + 0.15 * dy,
          1 - TILT,
          40 - TILT,
        );
        return;
      }
      brush(x, y, dx, dy, seconds);
    },
    pointerUp(x, y, cancelled) {
      if (press && !press.moved && !cancelled) gust(x, y);
      press = null;
      dragging = false;
    },
    brush,
    gust,
    reset() {
      time = 0;
      growth = 1;
      growing = false;
      grow = 1;
      spin = 0;
      spinVelocity = 0;
      tiltOffset = 0;
      ambientDebt = 0;
      falling.clear();
      primed = false;
      gone.fill(NEVER);
      goneDirty = true;
    },
    dispose() {
      renderer.dispose();
    },
  };
}
