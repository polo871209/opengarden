import { ATLAS_CELL, ATLAS_CELLS } from "./look.ts";
import {
  GROW_WIDTH,
  LEAF_SCALE,
  MOUND,
  REGROW_AFTER,
  SHADOW_SIZE,
  SUN_DIR,
  WIND,
  WIND_DIR,
  WIND_SPEED,
} from "./world.ts";

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

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
export const SHADOW_TILE = 8;

const SHADOW_RADIUS_TEXELS = 2.2 * 1.4;
const BILINEAR_REACH = 0.6;
const SHADOW_REACH = SHADOW_RADIUS_TEXELS + BILINEAR_REACH;
if (2 * SHADOW_REACH >= SHADOW_TILE)
  throw new Error("A shadow lookup must touch at most two tiles on each axis");

const frame = /* wgsl */ `
struct Frame {
  shadowMatrix: mat4x4f,
  stones: array<vec4f, 6>,
  time: f32,
  treeHeight: f32,
  grow: f32,
  blow: f32,
  fade: f32,
  stoneCount: f32,
  wipe: f32,
  origin: vec2f,
  aspect: f32,
}

fn hash12(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
`;

const fullscreen = /* wgsl */ `
@vertex fn fullscreenVertex(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[vertex], 0.0, 1.0);
}
`;

export const sceneShader = /* wgsl */ `
${frame}

struct Camera {
  viewProj: mat4x4f,
  right: vec4f,
  up: vec4f,
}

struct Look {
  crown: array<vec4f, 4>,
  moss: array<vec4f, 4>,
  ground: vec4f,
  gravel: vec4f,
  rake: vec4f,
  shadow: vec4f,
  bark: vec4f,
  barkShade: vec4f,
  rock: vec4f,
  rockShade: vec4f,
  sun: vec4f,
  snowColor: vec4f,
  crownShape: f32,
  crownDabShare: f32,
  mossShape: f32,
  mossDabShare: f32,
  snow: f32,
}

struct Draw {
  model: mat4x4f,
  variant: f32,
}

struct Leaf {
  position: vec3f,
  size: f32,
  normal: vec3f,
  angle: f32,
  rnd: f32,
  arrival: f32,
  exposure: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(1) var<uniform> look: Look;
@group(1) @binding(2) var atlasTexture: texture_2d<f32>;
@group(1) @binding(3) var atlasSampler: sampler;
@group(2) @binding(0) var<uniform> draw: Draw;
@group(2) @binding(1) var<storage, read> leaves: array<Leaf>;
@group(2) @binding(2) var<storage, read> fellAt: array<f32>;
@group(2) @binding(3) var<storage, read> drawOrder: array<u32>;
@group(3) @binding(0) var shadowMap: texture_depth_2d;
@group(3) @binding(1) var shadowSampler: sampler_comparison;
@group(3) @binding(2) var shadowRange: texture_2d<f32>;

const WIND = ${f(WIND)};
const WIND_SPEED = ${f(WIND_SPEED)};
const WIND_DIR = vec2f(${f(WIND_DIR[0])}, ${f(WIND_DIR[1])});
const SUN_DIR = vec3f(${SUN_DIR.map(f).join(", ")});
const GROW_WIDTH = ${f(GROW_WIDTH)};
const REGROW = ${f(REGROW_AFTER)};
const LEAF_SCALE = ${f(LEAF_SCALE)};
const MOSS_SCALE = 0.15;
const CROWN_VARY = 0.22;
const MOSS_VARY = 0.3;
const ATLAS_CELLS = ${f(ATLAS_CELLS)};
const DAB_CELL = ${f(ATLAS_CELL.dab)};
const SHADOW_SIZE = ${f(SHADOW_SIZE)};
const SHADOW_RADIUS = ${f(SHADOW_RADIUS_TEXELS / SHADOW_SIZE)};
const SHADOW_REACH = ${f(SHADOW_REACH)};
const SHADOW_TILE = ${SHADOW_TILE};
const SHADOW_TILES = ${SHADOW_SIZE / SHADOW_TILE};
const SHADOW_STRENGTH = 0.8;
const MOUND_RADIUS = ${f(MOUND.radius)};
const MOUND_HEIGHT = ${f(MOUND.height)};
const RAKE_RADIUS = ${f(1.02 * MOUND.radius)};
const RAKE_STRENGTH = 0.6;
const DRAG = 2.4;

const POISSON = array<vec2f, 16>(
  vec2f(-0.94201624, -0.39906216), vec2f(0.94558609, -0.76890725),
  vec2f(-0.09418410, -0.92938870), vec2f(0.34495938, 0.29387760),
  vec2f(-0.91588581, 0.45771432), vec2f(-0.81544232, -0.87912464),
  vec2f(-0.38277543, 0.27676845), vec2f(0.97484398, 0.75648379),
  vec2f(0.44323325, -0.97511554), vec2f(0.53742981, -0.47373420),
  vec2f(-0.26496911, -0.41893023), vec2f(0.79197514, 0.19090188),
  vec2f(-0.24188840, 0.99706507), vec2f(-0.81409955, 0.91437590),
  vec2f(0.19984126, 0.78641367), vec2f(0.14383161, -0.14100790),
);

fn windOffset(p: vec3f, wind: f32) -> vec3f {
  let h = max(p.y - 0.25, 0.0) / max(frame.treeHeight, 0.5);
  let bend = h * h * wind;
  let t = frame.time * WIND_SPEED;
  let sway = 0.55 + 0.45 * sin(t * 0.9 + p.x * 0.22 + p.z * 0.17);
  let gust = 0.5 + 0.5 * sin(t * 0.31 + 1.7) * sin(t * 0.53 + 0.4);
  let along = vec3f(WIND_DIR.x, 0.0, WIND_DIR.y);
  let across = vec3f(-WIND_DIR.y, 0.0, WIND_DIR.x);
  var offset = along * bend * (0.18 + 0.32 * sway * (0.6 + 0.8 * gust));
  offset += across * bend * 0.08 * sin(t * 1.7 + p.y * 0.9 + p.x);
  offset.y -= bend * 0.05 * (0.5 + 0.5 * sin(t * 1.1 + p.z));
  return offset;
}

fn occluderRange(texel: vec2f) -> vec2f {
  let last = vec2i(SHADOW_TILES - 1);
  let low = clamp(vec2i(floor(texel - SHADOW_REACH)) / SHADOW_TILE, vec2i(0), last);
  let high = clamp(vec2i(floor(texel + SHADOW_REACH)) / SHADOW_TILE, vec2i(0), last);
  let a = textureLoad(shadowRange, low, 0).xy;
  let b = textureLoad(shadowRange, vec2i(high.x, low.y), 0).xy;
  let c = textureLoad(shadowRange, vec2i(low.x, high.y), 0).xy;
  let d = textureLoad(shadowRange, high, 0).xy;
  return vec2f(min(min(a.x, b.x), min(c.x, d.x)), max(max(a.y, b.y), max(c.y, d.y)));
}

fn sunlight(coord: vec4f, bias: f32) -> f32 {
  let ndc = coord.xyz / coord.w;
  let c = vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, ndc.z);
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) {
    return 1.0;
  }
  let depth = c.z - bias;
  let occluders = occluderRange(c.xy * SHADOW_SIZE);
  if (depth <= occluders.x) {
    return 1.0;
  }
  if (depth > occluders.y) {
    return 0.0;
  }
  var lit = 0.0;
  for (var i = 0; i < 16; i++) {
    lit += textureSampleCompareLevel(shadowMap, shadowSampler, c.xy + POISSON[i] * SHADOW_RADIUS, depth);
  }
  return lit / 16.0;
}

fn dithered(color: vec3f, position: vec4f) -> vec3f {
  return color + (hash12(position.xy) - 0.5) / 255.0;
}

fn rampColor(ramp: array<vec4f, 4>, k: f32) -> vec3f {
  if (k < 0.38) {
    return mix(ramp[0].xyz, ramp[1].xyz, smoothstep(0.0, 0.38, k));
  }
  if (k < 0.74) {
    return mix(ramp[1].xyz, ramp[2].xyz, smoothstep(0.38, 0.74, k));
  }
  return mix(ramp[2].xyz, ramp[3].xyz, smoothstep(0.74, 1.0, k));
}

fn atlasTexel(cell: f32, uv: vec2f) -> vec4f {
  return textureSample(atlasTexture, atlasSampler, vec2f((cell + uv.x) / ATLAS_CELLS, 1.0 - uv.y));
}

fn crispAlpha(a: f32) -> f32 {
  return clamp((a - 0.5) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
}

fn quadCorner(vertex: u32) -> vec2f {
  var corners = array<vec2f, 6>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),
    vec2f(-0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5),
  );
  return corners[vertex];
}

fn billboard(center: vec3f, corner: vec2f, angle: f32, size: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  let q = vec2f(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
  return center + camera.right.xyz * q.x + camera.up.xyz * q.y;
}

fn moundHeight(xz: vec2f) -> f32 {
  let r = length(xz) / MOUND_RADIUS;
  return select(0.0, MOUND_HEIGHT * pow(1.0 - r * r, 1.3), r < 1.0);
}

fn easeOutBack(x: f32) -> f32 {
  let y = x - 1.0;
  return 1.0 + 2.9 * y * y * y + 1.9 * y * y;
}

fn hash11(n: f32) -> f32 {
  return fract(sin(n) * 43758.5453);
}

fn project(world: vec3f) -> vec4f {
  return camera.viewProj * vec4f(world, 1.0);
}

fn shadowCoord(world: vec3f) -> vec4f {
  return frame.shadowMatrix * vec4f(world, 1.0);
}

struct LeafOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) normal: vec3f,
  @location(2) rnd: f32,
  @location(3) exposure: f32,
  @location(4) @interpolate(flat) shape: f32,
  @location(5) shadowCoord: vec4f,
}

@vertex fn leafVertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> LeafOut {
  let index = drawOrder[instance];
  let leaf = leaves[index];
  let moss = draw.variant > 0.5;
  let wind = select(WIND, 0.0, moss);
  let grow = select(frame.grow, 1.0, moss);
  let blowing = select(frame.blow, 0.0, moss);
  var size = leaf.size * select(LEAF_SCALE, MOSS_SCALE, moss);
  var angle = leaf.angle;
  let rnd = leaf.rnd;
  let arrival = leaf.arrival;

  let grown = select(clamp((grow * (1.0 + GROW_WIDTH) - arrival) / GROW_WIDTH, 0.0, 1.0), 1.0, blowing > 0.0);
  size *= select(0.0, easeOutBack(grown), grown > 0.0);

  let along = vec3f(WIND_DIR.x, 0.0, WIND_DIR.y);
  let across = vec3f(-WIND_DIR.y, 0.0, WIND_DIR.x);
  let t = frame.time * WIND_SPEED;
  var p = leaf.position + windOffset(leaf.position, wind);
  angle += sin(t * (2.6 + rnd * 2.2) + rnd * 40.0) * 0.22 * wind;
  p += along * sin(t * (3.1 + rnd * 1.7) + rnd * 17.0) * 0.025 * wind;

  let lead = clamp(0.5 - dot(leaf.position, along) * 0.12, 0.0, 1.0);
  let blow = clamp((blowing - rnd * 0.32 - lead * 0.22) / 0.46, 0.0, 1.0);
  let scatter = vec3f(hash11(rnd * 91.0) - 0.5, hash11(rnd * 37.0) - 0.35, hash11(rnd * 53.0) - 0.5);
  p += along * (7.0 + rnd * 7.0) * blow * blow + scatter * 5.0 * blow;
  p += (vec3f(0.0, sin(blow * 3.0 + rnd * 9.0) * 0.6, 0.0) + across * sin(blow * 5.0 + rnd * 20.0) * 0.8) * blow;
  angle += blow * (5.0 + rnd * 9.0);
  size *= 1.0 - smoothstep(0.6, 1.0, blow);

  let since = frame.time - fellAt[index];
  let regrown = select(easeOutBack(clamp((since - REGROW) / 0.5, 0.0, 1.0)), 0.0, since < REGROW);
  size *= select(regrown, 1.0, since < 0.0);

  let corner = quadCorner(vertex);
  let world = billboard(p, corner, angle, size);
  let shape = select(look.crownShape, look.mossShape, moss);
  let dabShare = select(look.crownDabShare, look.mossDabShare, moss);

  var out: LeafOut;
  out.uv = corner + 0.5;
  out.shape = select(shape, DAB_CELL, fract(rnd * 7.31) < dabShare);
  out.normal = leaf.normal;
  out.rnd = rnd;
  out.exposure = leaf.exposure;
  out.shadowCoord = shadowCoord(world);
  out.position = project(world);
  return out;
}

@fragment fn leafFragment(in: LeafOut) -> @location(0) vec4f {
  let moss = draw.variant > 0.5;
  let tex = atlasTexel(in.shape, in.uv);
  let alpha = crispAlpha(tex.a);
  if (alpha < 0.02) {
    discard;
  }
  let n = normalize(in.normal);
  let sun = sunlight(in.shadowCoord, 0.0025);
  var light = 0.06 + 0.94 * smoothstep(-0.35, 0.7, dot(n, SUN_DIR));
  light *= mix(0.5, 1.0, sun);
  light *= mix(0.45, 1.0, smoothstep(0.2, 0.98, in.exposure));
  light += max(n.y, 0.0) * 0.12;
  let vary = select(CROWN_VARY, MOSS_VARY, moss);
  let k = clamp(light + (in.rnd - 0.5) * vary + (tex.r - 0.9) * 0.6, 0.0, 1.0);
  var ramp = look.crown;
  if (moss) {
    ramp = look.moss;
  }
  let color = rampColor(ramp, k) * mix(vec3f(1.0), look.sun.xyz, 0.15 * k);
  return vec4f(dithered(color, in.position), alpha);
}

@fragment fn leafDepthFragment(in: LeafOut) {
  if (atlasTexel(in.shape, in.uv).a < 0.5) {
    discard;
  }
}

struct BarkIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) center: vec3f,
  @location(3) arrival: f32,
  @location(4) uv: vec2f,
}

struct BarkOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f,
  @location(2) shadowCoord: vec4f,
}

@vertex fn barkVertex(in: BarkIn) -> BarkOut {
  var grown = clamp((frame.grow * (1.0 + GROW_WIDTH) - in.arrival) / GROW_WIDTH, 0.0, 1.0);
  grown = sqrt(grown) * (0.45 + 0.55 * clamp(frame.grow, 0.0, 1.0));
  let p = in.center + (in.position - in.center) * grown + windOffset(in.center, WIND);
  var out: BarkOut;
  out.normal = in.normal;
  out.uv = in.uv;
  out.shadowCoord = shadowCoord(p + in.normal * 0.03);
  out.position = project(p);
  return out;
}

@fragment fn barkFragment(in: BarkOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let sun = sunlight(in.shadowCoord, 0.0025);
  let light = smoothstep(-0.5, 0.45, dot(n, SUN_DIR)) * mix(0.35, 1.0, sun);
  var color = mix(look.barkShade.xyz, look.bark.xyz, smoothstep(0.25, 0.7, light));
  let cell = floor(in.uv * 9.0);
  let ring = fract(in.uv.y * 9.0 + hash12(cell) * 0.6);
  let lenticel = smoothstep(0.86, 0.9, ring) * (1.0 - smoothstep(0.95, 0.99, ring));
  color *= 1.0 - lenticel * 0.1;
  color *= 0.95 + hash12(vec2f(floor(in.uv.x * 14.0), floor(in.uv.y * 3.0))) * 0.07;
  let snow = look.snow * smoothstep(0.25, 0.6, n.y);
  color = mix(color, look.snowColor.xyz * mix(0.82, 1.0, sun), snow);
  return vec4f(dithered(color, in.position), 1.0);
}

struct GroundOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) shadowCoord: vec4f,
}

@vertex fn groundVertex(@builtin(vertex_index) vertex: u32) -> GroundOut {
  let corner = quadCorner(vertex) * 80.0;
  let world = vec3f(corner.x, 0.0, corner.y);
  var out: GroundOut;
  out.world = world;
  out.shadowCoord = shadowCoord(world);
  out.position = project(world);
  return out;
}

fn smoothMin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

@fragment fn groundFragment(in: GroundOut) -> @location(0) vec4f {
  let p = in.world.xz;
  let r = length(p);
  var d = r - RAKE_RADIUS;
  for (var i = 0; i < 6; i++) {
    if (f32(i) >= frame.stoneCount) {
      break;
    }
    let stone = frame.stones[i];
    d = smoothMin(d, length((p - stone.xy) / vec2f(1.0, stone.w)) - stone.z, 0.6);
  }

  let k = d / 0.2;
  let width = fwidth(k);
  let toLine = abs(fract(k) - 0.5) * 2.0;
  var groove = smoothstep(0.55 - width, 0.95 + width, 1.0 - toLine);
  groove *= 1.0 - smoothstep(0.35, 0.7, width);
  let near = smoothstep(5.5, 2.2, r) * smoothstep(0.0, 0.08, d);
  let gravel = smoothstep(11.5, 6.5, r);

  var color = mix(look.ground.xyz, look.gravel.xyz, gravel);
  color = mix(color, look.rake.xyz, groove * near * RAKE_STRENGTH * 0.5);
  color *= 1.0 + (hash12(floor(p * 55.0)) - 0.5) * 0.035 * gravel;

  let lit = sunlight(in.shadowCoord, 0.001);
  color = mix(color, look.shadow.xyz, (1.0 - lit) * SHADOW_STRENGTH * smoothstep(15.0, 9.0, r));
  return vec4f(dithered(color, in.position), 1.0);
}

struct SolidIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
}

struct SolidOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) shadowCoord: vec4f,
}

@vertex fn solidVertex(in: SolidIn) -> SolidOut {
  let world = (draw.model * vec4f(in.position, 1.0)).xyz;
  let model = mat3x3f(draw.model[0].xyz, draw.model[1].xyz, draw.model[2].xyz);
  let normal = normalize(model * in.normal);
  var out: SolidOut;
  out.normal = normal;
  out.world = world;
  out.shadowCoord = shadowCoord(world + normal * 0.05);
  out.position = project(world);
  return out;
}

@fragment fn solidFragment(in: SolidOut) -> @location(0) vec4f {
  let stone = draw.variant > 0.5;
  let lit = select(look.moss[1].xyz, look.rock.xyz, stone);
  let dark = select(look.moss[0].xyz, look.rockShade.xyz, stone);
  let grain = select(0.08, 0.05, stone);
  let n = normalize(in.normal);
  let sun = sunlight(in.shadowCoord, 0.0025);
  let light = smoothstep(-0.2, 0.55, dot(n, SUN_DIR)) * mix(0.3, 1.0, sun);
  var color = mix(dark, lit, smoothstep(0.15, 0.75, light));
  color *= 1.0 + (hash12(floor(in.world.xz * 30.0 + in.world.y * 17.0)) - 0.5) * grain;
  let snow = select(0.0, look.snow, stone) * smoothstep(0.35, 0.7, n.y);
  color = mix(color, look.snowColor.xyz * mix(0.8, 1.0, sun), snow);
  return vec4f(dithered(color, in.position), 1.0);
}

struct FallIn {
  @builtin(vertex_index) vertex: u32,
  @location(0) start: vec3f,
  @location(1) velocity: vec3f,
  @location(2) terminal: vec3f,
  @location(3) timing: vec4f,
  @location(4) look: vec4f,
}

struct FallOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) rnd: f32,
  @location(2) alpha: f32,
  @location(3) landed: f32,
  @location(4) flip: f32,
  @location(5) @interpolate(flat) shape: f32,
  @location(6) ambient: f32,
  @location(7) shadowCoord: vec4f,
}

@vertex fn fallVertex(in: FallIn) -> FallOut {
  let spawn = in.timing.x;
  let airTime = in.timing.y;
  let restTime = in.timing.z;
  let seed = in.timing.w;
  let size = in.look.x;
  let spin = in.look.y;
  let rnd = in.look.z;
  let ambient = step(0.5, in.look.w);
  let snow = step(1.5, in.look.w);
  let shown = mix(1.0, mix(1.0 - look.snow, look.snow, snow), ambient);

  let age = frame.time - spawn;
  let life = airTime + restTime;
  let tf = clamp(age, 0.0, airTime);
  let e = (1.0 - exp(-DRAG * tf)) / DRAG;
  var p = in.start + in.velocity * e + in.terminal * (tf - e);
  var across = vec3f(1.0, 0.0, 0.0);
  let side = vec3f(-in.terminal.z, 0.0, in.terminal.x);
  if (dot(side, side) > 1e-6) {
    across = normalize(side);
  }
  let flutter = smoothstep(0.0, 0.8, tf) * (1.0 - smoothstep(airTime - 0.6, airTime, tf));
  p += across * sin(tf * (1.8 + fract(seed * 5.1)) + seed * 30.0) * mix(0.3, 0.12, snow) * flutter;

  let landed = smoothstep(airTime, airTime + 0.18, age);
  let lift = select(0.012, 0.07, length(p.xz) < MOUND_RADIUS);
  p.y = max(p.y, moundHeight(p.xz) + mix(0.0, lift + fract(seed * 91.0) * 0.008, landed));

  var alpha = step(0.0, age) * step(age, life);
  let fadeOut = mix(2.5, 1.2, ambient);
  alpha *= smoothstep(0.0, 0.3, age) * (1.0 - smoothstep(life - fadeOut, life, age));
  alpha *= mix(1.0, 0.75, landed * ambient) * frame.fade * shown;

  let angle = spin * tf + seed * 6.28;
  let flip = cos(tf * (2.0 + spin));
  var corner = quadCorner(in.vertex);
  let uv = corner + 0.5;
  corner.x *= mix(abs(flip) * 0.85 + 0.15, 1.0, landed);
  let sz = size * LEAF_SCALE * step(0.001, alpha);

  let airborne = billboard(p, corner, angle, sz);
  let squashed = billboard(p, corner * vec2f(1.0, 0.42), angle, sz);
  let tangentX = vec3f(cos(angle), 0.0, sin(angle));
  let tangentZ = normalize(vec3f(-sin(angle), 0.0, cos(angle)) + vec3f(0.0, 0.5, 0.0));
  let lying = p + (tangentX * corner.x + tangentZ * corner.y) * sz;
  let world = mix(airborne, mix(lying, squashed, ambient), landed);

  var out: FallOut;
  out.uv = uv;
  out.rnd = rnd;
  out.alpha = alpha;
  out.landed = landed;
  out.flip = abs(flip);
  out.ambient = ambient;
  out.shape = select(look.crownShape, DAB_CELL, ambient < 0.5 && fract(rnd * 7.31) < look.crownDabShare);
  out.shadowCoord = shadowCoord(world);
  out.position = project(world);
  return out;
}

@fragment fn fallFragment(in: FallOut) -> @location(0) vec4f {
  let tex = atlasTexel(in.shape, in.uv);
  let alpha = crispAlpha(tex.a) * in.alpha;
  if (alpha < 0.02) {
    discard;
  }
  var color: vec3f;
  if (in.ambient > 0.5) {
    let pick = fract(in.rnd * 13.7);
    var base = look.crown[3].xyz;
    if (pick < 0.34) {
      base = look.crown[0].xyz;
    } else if (pick < 0.62) {
      base = look.crown[1].xyz;
    } else if (pick < 0.84) {
      base = look.crown[2].xyz;
    }
    let shade = mix(0.82 + 0.18 * in.flip, 0.9, in.landed);
    color = base * shade * mix(0.88, 1.0, tex.r);
  } else {
    let sun = sunlight(in.shadowCoord, 0.0025);
    var k = 0.5 + (in.rnd - 0.5) * 0.7 + (tex.r - 0.9) * 0.6 + (in.flip - 0.5) * 0.25 * (1.0 - in.landed);
    k = clamp(k, 0.0, 1.0) * mix(0.55, 1.0, sun * mix(1.0, 0.9, in.landed));
    color = rampColor(look.crown, k);
  }
  return vec4f(dithered(color, in.position), alpha);
}
`;

export const shadowRangeShader = /* wgsl */ `
@group(0) @binding(0) var shadowMap: texture_depth_2d;
@group(0) @binding(1) var nearest: sampler;

${fullscreen}

@fragment fn shadowRangeFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let corner = floor(position.xy) * ${f(SHADOW_TILE)};
  var near = 1.0;
  var far = 0.0;
  for (var y = 1.0; y < ${f(SHADOW_TILE)}; y += 2.0) {
    for (var x = 1.0; x < ${f(SHADOW_TILE)}; x += 2.0) {
      let depths = textureGather(shadowMap, nearest, (corner + vec2f(x, y)) / ${f(SHADOW_SIZE)});
      near = min(near, min(min(depths.x, depths.y), min(depths.z, depths.w)));
      far = max(far, max(max(depths.x, depths.y), max(depths.z, depths.w)));
    }
  }
  return vec4f(near, far, 0.0, 0.0);
}
`;

export const wipeShader = /* wgsl */ `
${frame}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var incoming: texture_2d<f32>;

const RIM = 0.012;
const RIM_COLOR = vec3f(1.0);

${fullscreen}

@fragment fn wipeFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(incoming));
  let uv = vec2f(position.x / size.x, 1.0 - position.y / size.y);
  let next = textureLoad(incoming, vec2i(position.xy), 0).rgb;
  let q = (uv - frame.origin) * vec2f(frame.aspect, 1.0);
  let theta = atan2(q.y, q.x);
  let phase = frame.wipe * 4.0;
  let wobble = 1.0 + 0.045 * sin(theta * 5.0 + phase) + 0.025 * sin(theta * 9.0 - phase * 1.7 + 1.1) + 0.012 * sin(theta * 17.0 + phase * 2.3);
  let edge = length(q) * wobble;
  let front = frame.wipe * (length(vec2f(frame.aspect, 1.0)) * 1.15 + RIM * 2.0);
  let aa = 1.5 * fwidth(edge);
  let inside = 1.0 - smoothstep(front - RIM - aa, front - RIM + aa, edge);
  let rim = smoothstep(front - RIM - aa, front - RIM + aa, edge) * (1.0 - smoothstep(front - aa, front + aa, edge));
  let ahead = (1.0 - smoothstep(front, front + 0.03, edge)) * (1.0 - rim) * (1.0 - inside);
  let outgoing = (1.0 - 0.12 * ahead) * (1.0 - inside) * (1.0 - rim);
  return vec4f(next * inside * (1.0 - rim) + RIM_COLOR * rim, outgoing);
}
`;
