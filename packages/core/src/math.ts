/**
 * A 3D vector with the part of the three.js `Vector3` API that trees use.
 * Each method changes the vector and returns it, except `clone`, `dot`,
 * `length`, `lengthSq`, `distanceTo` and `distanceToSquared`.
 */
export class Vector3 {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  setY(y: number): this {
    this.y = y;
    return this;
  }

  copy(v: Vector3): this {
    return this.set(v.x, v.y, v.z);
  }

  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  add(v: Vector3): this {
    return this.set(this.x + v.x, this.y + v.y, this.z + v.z);
  }

  sub(v: Vector3): this {
    return this.set(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  multiplyScalar(s: number): this {
    return this.set(this.x * s, this.y * s, this.z * s);
  }

  addScaledVector(v: Vector3, s: number): this {
    return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s);
  }

  /** Sets this vector to `a` cross `b`, or to itself cross `a` if `b` is missing. */
  cross(a: Vector3, b?: Vector3): this {
    const [u, v] = b ? [a, b] : [this.clone(), a];
    return this.set(
      u.y * v.z - u.z * v.y,
      u.z * v.x - u.x * v.z,
      u.x * v.y - u.y * v.x,
    );
  }

  dot(v: Vector3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  lengthSq(): number {
    return this.dot(this);
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  /** Scales the vector to length 1. A zero vector stays zero. */
  normalize(): this {
    return this.multiplyScalar(1 / (this.length() || 1));
  }

  distanceToSquared(v: Vector3): number {
    return (this.x - v.x) ** 2 + (this.y - v.y) ** 2 + (this.z - v.z) ** 2;
  }

  distanceTo(v: Vector3): number {
    return Math.sqrt(this.distanceToSquared(v));
  }

  lerp(v: Vector3, t: number): this {
    return this.set(
      this.x + (v.x - this.x) * t,
      this.y + (v.y - this.y) * t,
      this.z + (v.z - this.z) * t,
    );
  }

  /** Turns the vector by `angle` radians around the unit vector `axis`. */
  applyAxisAngle(axis: Vector3, angle: number): this {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const along = axis.dot(this) * (1 - cos);
    const turned = axis.clone().cross(this);
    return this.multiplyScalar(cos)
      .addScaledVector(turned, sin)
      .addScaledVector(axis, along);
  }

  toArray(): [number, number, number];
  toArray<T extends { [index: number]: number }>(out: T, offset?: number): T;
  toArray(out: { [index: number]: number } = [], offset = 0) {
    out[offset] = this.x;
    out[offset + 1] = this.y;
    out[offset + 2] = this.z;
    return out;
  }
}

/** A 4x4 matrix as 16 numbers, column by column. */
export type Matrix = Float32Array | number[];

export function multiply(a: Matrix, b: Matrix, out: Matrix): Matrix {
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  return out;
}

/** The world placement and projection of a camera. Projections use WebGPU clip space, with depth from 0 to 1. */
export class Camera {
  readonly position = new Vector3();
  readonly right = new Vector3(1, 0, 0);
  readonly up = new Vector3(0, 1, 0);
  /** Points away from where the camera looks. */
  readonly back = new Vector3(0, 0, 1);
  projection: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  private frustum = { left: -1, right: 1, top: 1, bottom: -1, near: 1 };

  /** A perspective projection whose frustum is moved right by `shift` of its width. */
  perspective(
    fov: number,
    aspect: number,
    near: number,
    far: number,
    shift = 0,
  ): void {
    const top = near * Math.tan(fov / 2);
    const width = 2 * top * aspect;
    const left = -width / 2 - shift * width;
    this.frustum = { left, right: left + width, top, bottom: -top, near };
    const { right } = this.frustum;
    this.projection = [
      (2 * near) / width,
      0,
      0,
      0,
      0,
      near / top,
      0,
      0,
      (right + left) / width,
      0,
      -far / (far - near),
      -1,
      0,
      0,
      (-far * near) / (far - near),
      0,
    ];
  }

  orthographic(size: number, near: number, far: number): void {
    this.projection = [
      1 / size,
      0,
      0,
      0,
      0,
      1 / size,
      0,
      0,
      0,
      0,
      -1 / (far - near),
      0,
      0,
      0,
      -near / (far - near),
      1,
    ];
  }

  lookAt(target: Vector3): void {
    this.back.copy(this.position).sub(target).normalize();
    this.right.cross(new Vector3(0, 1, 0), this.back).normalize();
    this.up.cross(this.back, this.right);
  }

  /** Projection times view, column by column. */
  viewProjection(out: Matrix): Matrix {
    const { right: x, up: y, back: z, position: p } = this;
    const view = [
      x.x,
      y.x,
      z.x,
      0,
      x.y,
      y.y,
      z.y,
      0,
      x.z,
      y.z,
      z.z,
      0,
      -x.dot(p),
      -y.dot(p),
      -z.dot(p),
      1,
    ];
    return multiply(this.projection, view, out);
  }

  /** The direction from the camera through a point on screen, from -1 to 1 on each axis with y up. */
  ray(x: number, y: number): Vector3 {
    const { left, right, top, bottom, near } = this.frustum;
    return new Vector3()
      .addScaledVector(this.right, left + ((x + 1) / 2) * (right - left))
      .addScaledVector(this.up, bottom + ((y + 1) / 2) * (top - bottom))
      .addScaledVector(this.back, -near)
      .normalize();
  }
}

export const clamp = (x: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, x));

export const radians = (degrees: number): number => (degrees * Math.PI) / 180;
