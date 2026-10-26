import { type Matrix, Vector3 } from "./math.ts";
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

/** Positions, 3 floats each, and the triangles that index them. Without indices, each 3 positions make a triangle. */
function solidMesh(positions: Float32Array, indices?: number[]): Mesh {
  const count = positions.length / 3;
  const at = (i: number) =>
    new Vector3(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
  const normals = new Float32Array(positions.length);
  const triangles = indices ?? Array.from({ length: count }, (_, i) => i);
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const pb = at(b);
    const face = at(c).sub(pb).cross(at(a).sub(pb));
    for (const v of [a, b, c]) {
      normals[3 * v] += face.x;
      normals[3 * v + 1] += face.y;
      normals[3 * v + 2] += face.z;
    }
  }
  const vertices = new Float32Array(SOLID_FLOATS * count);
  for (let i = 0; i < count; i++) {
    const n = new Vector3(
      normals[3 * i],
      normals[3 * i + 1],
      normals[3 * i + 2],
    ).normalize();
    vertices.set(
      [
        positions[3 * i],
        positions[3 * i + 1],
        positions[3 * i + 2],
        n.x,
        n.y,
        n.z,
      ],
      SOLID_FLOATS * i,
    );
  }
  return { vertices, indices: indices && new Uint32Array(indices) };
}

const PHI = (1 + Math.sqrt(5)) / 2;
// biome-ignore format: 4 vertices per row
const ICOSAHEDRON_VERTICES = [
  -1, PHI, 0, 1, PHI, 0, -1, -PHI, 0, 1, -PHI, 0,
  0, -1, PHI, 0, 1, PHI, 0, -1, -PHI, 0, 1, -PHI,
  PHI, 0, -1, PHI, 0, 1, -PHI, 0, -1, -PHI, 0, 1,
];
// biome-ignore format: 5 faces per row
const ICOSAHEDRON_FACES = [
  0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
  1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
  4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
];

// Adapted from three.js PolyhedronGeometry, so the stones keep their shape: https://github.com/mrdoob/three.js/blob/r186/src/geometries/PolyhedronGeometry.js
function icosphere(detail: number): Float32Array {
  const out: number[] = [];
  const corner = (i: number) =>
    new Vector3(
      ICOSAHEDRON_VERTICES[3 * i],
      ICOSAHEDRON_VERTICES[3 * i + 1],
      ICOSAHEDRON_VERTICES[3 * i + 2],
    );
  const push = (v: Vector3) => out.push(v.x, v.y, v.z);
  const cols = detail + 1;
  for (let f = 0; f < ICOSAHEDRON_FACES.length; f += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => corner(ICOSAHEDRON_FACES[f + k]));
    const v: Vector3[][] = [];
    for (let i = 0; i <= cols; i++) {
      const aj = a.clone().lerp(c, i / cols);
      const bj = b.clone().lerp(c, i / cols);
      const rows = cols - i;
      v[i] = [];
      for (let j = 0; j <= rows; j++)
        v[i][j] = j === 0 && i === cols ? aj : aj.clone().lerp(bj, j / rows);
    }
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < 2 * (cols - i) - 1; j++) {
        const k = Math.floor(j / 2);
        if (j % 2 === 0) {
          push(v[i][k + 1]);
          push(v[i + 1][k]);
          push(v[i][k]);
        } else {
          push(v[i][k + 1]);
          push(v[i + 1][k + 1]);
          push(v[i + 1][k]);
        }
      }
  }
  const positions = new Float32Array(out);
  for (let i = 0; i < positions.length; i += 3)
    new Vector3(positions[i], positions[i + 1], positions[i + 2])
      .normalize()
      .toArray(positions, i);
  return positions;
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
  return solidMesh(new Float32Array(positions), indices);
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
  model: Matrix;
  /** Center x and z, radius, and depth as a share of width. */
  footprint: [number, number, number, number];
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
    const positions = icosphere(4);
    const phase = 100 * rng();
    const v = new Vector3();
    for (let k = 0; k < positions.length; k += 3) {
      v.set(positions[k], positions[k + 1], positions[k + 2]);
      const lumps =
        Math.sin(2.1 * v.x + phase) *
        Math.sin(2.7 * v.y + 1.3 * phase) *
        Math.sin(1.9 * v.z + 0.7 * phase);
      const pits =
        Math.sin(5.3 * v.x + 2 * phase) * Math.sin(4.7 * v.z + phase);
      v.multiplyScalar(1 + 0.12 * lumps + 0.025 * pits);
      v.toArray(positions, k);
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
    const cos = Math.cos(rotationY);
    const sin = Math.sin(rotationY);
    stones.push({
      mesh: solidMesh(positions),
      // biome-ignore format: one matrix column per row
      model: [
        cos * scale.x, 0, -sin * scale.x, 0,
        0, scale.y, 0, 0,
        sin * scale.z, 0, cos * scale.z, 0,
        x, 0.35 * height, z, 1,
      ],
      footprint: [x, z, 0.95 * Math.max(scale.x, scale.z), scale.z / scale.x],
    });
  }
  return stones;
}
