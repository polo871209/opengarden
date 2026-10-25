import {
  BufferGeometry,
  Euler,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  Vector3,
  Vector4,
} from "three";
import type { Rng } from "./rng.ts";
import { type Leaf, perpendicular, type Tree } from "./tree.ts";
import { type MoundShape, moundHeight } from "./world.ts";

/** Interleaved vertex floats, and triangle indices if the mesh has them. */
export interface Mesh {
  vertices: Float32Array<ArrayBuffer>;
  indices?: Uint32Array<ArrayBuffer>;
}

/** Floats per bark vertex: position 3, normal 3, branch center 3, arrival 1, uv 2. */
export const BARK_FLOATS = 12;
/** Floats per solid vertex: position 3, normal 3. */
export const SOLID_FLOATS = 6;
export const LEAF_FLOATS = 12;
/** The time a leaf fell, for a leaf that never fell. */
export const NEVER = -1e4;

export function createBarkMesh(tree: Tree): Mesh {
  const vertices: number[] = [];
  const indices: number[] = [];
  let base = 0;

  for (const branch of tree.branches) {
    const sides = branch.depth === 0 ? 12 : branch.depth === 1 ? 8 : 6;
    const count = branch.points.length;
    let side: Vector3 | null = null;
    for (let i = 0; i < count; i++) {
      const next = branch.points[Math.min(i + 1, count - 1)];
      const prev = branch.points[Math.max(i - 1, 0)];
      const tangent = next.clone().sub(prev).normalize();
      side = side
        ? side.addScaledVector(tangent, -side.dot(tangent)).normalize()
        : perpendicular(tangent);
      if (side.lengthSq() < 1e-6) side = perpendicular(tangent);
      const binormal = tangent.clone().cross(side).normalize();
      const center = branch.points[i];
      const radius = branch.radii[i];
      for (let j = 0; j <= sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        const n = side
          .clone()
          .multiplyScalar(Math.cos(a))
          .addScaledVector(binormal, Math.sin(a));
        vertices.push(
          center.x + n.x * radius,
          center.y + n.y * radius,
          center.z + n.z * radius,
          n.x,
          n.y,
          n.z,
          center.x,
          center.y,
          center.z,
          branch.arrival[i],
          j / sides,
          branch.along[i],
        );
      }
    }
    for (let i = 0; i < count - 1; i++) {
      for (let j = 0; j < sides; j++) {
        const a = base + i * (sides + 1) + j;
        const b = a + sides + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    base += count * (sides + 1);
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
  };
}

export function createLeafInstances(leaves: Leaf[]): Float32Array<ArrayBuffer> {
  const data = new Float32Array(LEAF_FLOATS * leaves.length);
  leaves.forEach((leaf, i) => {
    const at = LEAF_FLOATS * i;
    leaf.position.toArray(data, at);
    data[at + 3] = leaf.size;
    leaf.normal.toArray(data, at + 4);
    data[at + 7] = leaf.angle;
    data[at + 8] = leaf.rnd;
    data[at + 9] = leaf.arrival;
    data[at + 10] = leaf.exposure;
  });
  return data;
}

function solidMesh(geometry: BufferGeometry): Mesh {
  geometry.computeVertexNormals();
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const vertices = new Float32Array(SOLID_FLOATS * position.count);
  for (let i = 0; i < position.count; i++)
    vertices.set(
      [
        position.getX(i),
        position.getY(i),
        position.getZ(i),
        normal.getX(i),
        normal.getY(i),
        normal.getZ(i),
      ],
      SOLID_FLOATS * i,
    );
  const index = geometry.getIndex();
  return {
    vertices,
    indices: index ? new Uint32Array(index.array) : undefined,
  };
}

export function createMoundMesh(mound: MoundShape): Mesh {
  const rings = 22;
  const segments = 72;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    for (let j = 0; j <= segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const wobble =
        1 + 0.06 * Math.sin(3 * a + 1) + 0.04 * Math.sin(7 * a + 2);
      const r = t * mound.radius * wobble;
      const y = mound.height * (1 - t * t) ** 1.3 - (t > 0.97 ? 0.02 : 0);
      positions.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j;
      const b = a + segments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return solidMesh(geometry);
}

export function scatterMoss(
  mound: MoundShape,
  rng: Rng,
  count: number,
): Leaf[] {
  const moss: Leaf[] = [];
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const r = 0.98 * Math.sqrt(rng()) * mound.radius;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    moss.push({
      position: new Vector3(x, moundHeight(mound, x, z) + 0.02, z),
      normal: new Vector3(
        (1.3 * x) / mound.radius,
        1,
        (1.3 * z) / mound.radius,
      ).normalize(),
      size: 0.7 + 0.6 * rng(),
      angle: 6.28 * rng(),
      rnd: rng(),
      arrival: 0,
      exposure: 0.6 + 0.4 * rng(),
    });
  }
  return moss;
}

export interface Stone {
  mesh: Mesh;
  model: Matrix4;
  footprint: Vector4;
}

export function placeStones(
  mound: MoundShape,
  rng: Rng,
  count: number,
): Stone[] {
  const stones: Stone[] = [];
  const front = Math.PI / 2;
  const turn = rng() < 0.5 ? 1 : -1;
  for (let i = 0; i < count; i++) {
    const first = i === 0;
    const size = first ? 0.55 + 0.15 * rng() : 0.28 + 0.18 * rng();
    const angle =
      front +
      turn *
        (1.15 +
          ((i + 0.5) / count) * (Math.PI * 2 - 2.3) +
          (rng() - 0.5) * 0.35);
    const distance = mound.radius + (first ? 0.2 : 0.6 + 1.6 * rng());
    const geometry = new IcosahedronGeometry(1, 4);
    const position = geometry.getAttribute("position");
    const phase = 100 * rng();
    const v = new Vector3();
    for (let k = 0; k < position.count; k++) {
      v.fromBufferAttribute(position, k);
      const lumps =
        Math.sin(2.1 * v.x + phase) *
        Math.sin(2.7 * v.y + 1.3 * phase) *
        Math.sin(1.9 * v.z + 0.7 * phase);
      const pits =
        Math.sin(5.3 * v.x + 2 * phase) * Math.sin(4.7 * v.z + phase);
      v.multiplyScalar(1 + 0.12 * lumps + 0.025 * pits);
      position.setXYZ(k, v.x, v.y, v.z);
    }
    const height = size * (0.55 + 0.3 * rng());
    const scale = new Vector3(
      size * (1.1 + 0.4 * rng()),
      height,
      size * (0.9 + 0.3 * rng()),
    );
    const rotationY = 6.28 * rng();
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    stones.push({
      mesh: solidMesh(geometry),
      model: new Matrix4().compose(
        new Vector3(x, 0.35 * height, z),
        new Quaternion().setFromEuler(new Euler(0, rotationY, 0)),
        scale,
      ),
      footprint: new Vector4(
        x,
        z,
        0.95 * Math.max(scale.x, scale.z),
        scale.z / scale.x,
      ),
    });
  }
  return stones;
}
