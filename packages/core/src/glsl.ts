import { ATLAS_CELL, ATLAS_CELLS } from "./look.ts";
import type { Settings } from "./quality.ts";
import { f, SHADOW_RADIUS_TEXELS } from "./uniforms.ts";
import {
  GROW_WIDTH,
  MOUND,
  REGROW_AFTER,
  SUN_DIR,
  WIND,
  WIND_DIR,
  WIND_SPEED,
} from "./world.ts";

/** Uniform block names and their binding points. */
export const BLOCKS = { Camera: 0, Frame: 1, Look: 2, Draw: 3 } as const;
/** Sampler names and their texture units. */
export const UNITS = { atlas: 0, shadowMap: 1, incoming: 2 } as const;

export interface Program {
  vertex: string;
  fragment: string;
}

/** The GLSL ES 3.00 programs of the WebGL renderer, ported from the WGSL in `wgsl.ts`. */
export interface Programs {
  leaf: Program;
  leafDepth: Program;
  bark: Program;
  barkDepth: Program;
  ground: Program;
  solid: Program;
  solidDepth: Program;
  fall: Program;
  wipe: Program;
}

const vec3 = (v: readonly number[]) => `vec3(${v.map(f).join(", ")})`;

const POISSON = [
  [-0.94201624, -0.39906216],
  [0.94558609, -0.76890725],
  [-0.0941841, -0.9293887],
  [0.34495938, 0.2938776],
  [-0.91588581, 0.45771432],
  [-0.81544232, -0.87912464],
  [-0.38277543, 0.27676845],
  [0.97484398, 0.75648379],
  [0.44323325, -0.97511554],
  [0.53742981, -0.4737342],
  [-0.26496911, -0.41893023],
  [0.79197514, 0.19090188],
  [-0.2418884, 0.99706507],
  [-0.81409955, 0.9143759],
  [0.19984126, 0.78641367],
  [0.14383161, -0.1410079],
];

export function glslPrograms(settings: Settings, antialias: boolean): Programs {
  const header = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

layout(std140) uniform Camera {
  mat4 viewProj;
  vec4 right;
  vec4 up;
} camera;

layout(std140) uniform Frame {
  mat4 shadowMatrix;
  vec4 stones[6];
  float time;
  float treeHeight;
  float grow;
  float blow;
  float fade;
  float stoneCount;
  float wipe;
  vec2 origin;
  float aspect;
} frame;

layout(std140) uniform Look {
  vec4 crown[4];
  vec4 moss[4];
  vec4 ground;
  vec4 gravel;
  vec4 rake;
  vec4 shadow;
  vec4 bark;
  vec4 barkShade;
  vec4 rock;
  vec4 rockShade;
  vec4 sun;
  vec4 snowColor;
  float crownShape;
  float crownDabShare;
  float mossShape;
  float mossDabShare;
  float snow;
} look;

layout(std140) uniform Draw {
  mat4 model;
  float variant;
} draw;

const float WIND = ${f(WIND)};
const float WIND_SPEED = ${f(WIND_SPEED)};
const vec2 WIND_DIR = vec2(${f(WIND_DIR[0])}, ${f(WIND_DIR[1])});
const vec3 SUN_DIR = ${vec3(SUN_DIR)};
const float GROW_WIDTH = ${f(GROW_WIDTH)};
const float REGROW = ${f(REGROW_AFTER)};
const float LEAF_SCALE = ${f(settings.leafScale)};
const float MOSS_SCALE = 0.15;
const float CROWN_VARY = 0.22;
const float MOSS_VARY = 0.3;
const float ATLAS_CELLS = ${f(ATLAS_CELLS)};
const float DAB_CELL = ${f(ATLAS_CELL.dab)};
const float SHADOW_RADIUS = ${f(SHADOW_RADIUS_TEXELS / settings.shadowSize)};
const float SHADOW_STRENGTH = 0.8;
const float MOUND_RADIUS = ${f(MOUND.radius)};
const float MOUND_HEIGHT = ${f(MOUND.height)};
const float RAKE_RADIUS = ${f(1.02 * MOUND.radius)};
const float RAKE_STRENGTH = 0.6;
const float DRAG = 2.4;

float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
`;

  const vertexLib = /* glsl */ `
vec3 windOffset(vec3 p, float wind) {
  float h = max(p.y - 0.25, 0.0) / max(frame.treeHeight, 0.5);
  float bend = h * h * wind;
  float t = frame.time * WIND_SPEED;
  float sway = 0.55 + 0.45 * sin(t * 0.9 + p.x * 0.22 + p.z * 0.17);
  float gust = 0.5 + 0.5 * sin(t * 0.31 + 1.7) * sin(t * 0.53 + 0.4);
  vec3 along = vec3(WIND_DIR.x, 0.0, WIND_DIR.y);
  vec3 across = vec3(-WIND_DIR.y, 0.0, WIND_DIR.x);
  vec3 offset = along * bend * (0.18 + 0.32 * sway * (0.6 + 0.8 * gust));
  offset += across * bend * 0.08 * sin(t * 1.7 + p.y * 0.9 + p.x);
  offset.y -= bend * 0.05 * (0.5 + 0.5 * sin(t * 1.1 + p.z));
  return offset;
}

vec2 quadCorner(int vertex) {
  vec2 corners[6] = vec2[6](
    vec2(-0.5, -0.5), vec2(0.5, -0.5), vec2(0.5, 0.5),
    vec2(-0.5, -0.5), vec2(0.5, 0.5), vec2(-0.5, 0.5)
  );
  return corners[vertex];
}

vec3 billboard(vec3 center, vec2 corner, float angle, float size) {
  float c = cos(angle);
  float s = sin(angle);
  vec2 q = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
  return center + camera.right.xyz * q.x + camera.up.xyz * q.y;
}

float moundHeight(vec2 xz) {
  float r = length(xz) / MOUND_RADIUS;
  return r < 1.0 ? MOUND_HEIGHT * pow(1.0 - r * r, 1.3) : 0.0;
}

float easeOutBack(float x) {
  float y = x - 1.0;
  return 1.0 + 2.9 * y * y * y + 1.9 * y * y;
}

float hash11(float n) {
  return fract(sin(n) * 43758.5453);
}

// The cameras use WebGPU clip space, with depth from 0 to 1. WebGL clips depth from -1 to 1.
vec4 project(vec3 world) {
  vec4 p = camera.viewProj * vec4(world, 1.0);
  p.z = 2.0 * p.z - p.w;
  return p;
}

vec4 shadowCoord(vec3 world) {
  return frame.shadowMatrix * vec4(world, 1.0);
}
`;

  const sunlight = (name: string, samples: number) => {
    const lookup =
      samples === 1
        ? "return texture(shadowMap, vec3(c.xy, depth));"
        : `float lit = 0.0;
  for (int i = 0; i < ${samples}; i++) {
    lit += texture(shadowMap, vec3(c.xy + POISSON[i] * SHADOW_RADIUS, depth));
  }
  return lit / ${f(samples)};`;
    return /* glsl */ `
float ${name}(vec4 coord, float bias) {
  vec3 ndc = coord.xyz / coord.w;
  vec3 c = vec3(ndc.xy * 0.5 + 0.5, ndc.z);
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) {
    return 1.0;
  }
  float depth = c.z - bias;
  ${lookup}
}
`;
  };

  const atlas = /* glsl */ `
uniform sampler2D atlas;

vec4 atlasTexel(float cell, vec2 uv) {
  return texture(atlas, vec2((cell + uv.x) / ATLAS_CELLS, 1.0 - uv.y));
}
`;

  const fragmentLib = /* glsl */ `
precision highp sampler2DShadow;
uniform sampler2DShadow shadowMap;

const vec2 POISSON[16] = vec2[16](
  ${POISSON.map(([x, y]) => `vec2(${f(x)}, ${f(y)})`).join(",\n  ")}
);

${atlas}
${sunlight("sunlight", settings.shadowSamples)}
${sunlight("leafSunlight", settings.leafShadowSamples)}

vec3 dithered(vec3 color) {
  return color + (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
}

vec3 rampColor(vec4 ramp[4], float k) {
  if (k < 0.38) {
    return mix(ramp[0].xyz, ramp[1].xyz, smoothstep(0.0, 0.38, k));
  }
  if (k < 0.74) {
    return mix(ramp[1].xyz, ramp[2].xyz, smoothstep(0.38, 0.74, k));
  }
  return mix(ramp[2].xyz, ramp[3].xyz, smoothstep(0.74, 1.0, k));
}

float crispAlpha(float a) {
  return clamp((a - 0.5) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
}

out vec4 fragColor;
`;

  const vertex = (body: string) => `${header}${vertexLib}${body}`;
  const fragment = (body: string) => `${header}${fragmentLib}${body}`;
  const depthFragment = (body: string) => `${header}${body}`;

  const leafVertex = vertex(/* glsl */ `
layout(location = 0) in vec4 iPositionSize;
layout(location = 1) in vec4 iNormalAngle;
layout(location = 2) in vec4 iRndArrivalExposure;
layout(location = 3) in float iFellAt;

out vec2 vUv;
out vec3 vNormal;
out float vRnd;
out float vExposure;
flat out float vShape;
out vec4 vShadowCoord;

void main() {
  bool moss = draw.variant > 0.5;
  float wind = moss ? 0.0 : WIND;
  float grow = moss ? 1.0 : frame.grow;
  float blowing = moss ? 0.0 : frame.blow;
  vec3 position = iPositionSize.xyz;
  float size = iPositionSize.w * (moss ? MOSS_SCALE : LEAF_SCALE);
  float angle = iNormalAngle.w;
  float rnd = iRndArrivalExposure.x;
  float arrival = iRndArrivalExposure.y;

  float grown = blowing > 0.0 ? 1.0 : clamp((grow * (1.0 + GROW_WIDTH) - arrival) / GROW_WIDTH, 0.0, 1.0);
  size *= grown > 0.0 ? easeOutBack(grown) : 0.0;

  vec3 along = vec3(WIND_DIR.x, 0.0, WIND_DIR.y);
  vec3 across = vec3(-WIND_DIR.y, 0.0, WIND_DIR.x);
  float t = frame.time * WIND_SPEED;
  vec3 p = position + windOffset(position, wind);
  angle += sin(t * (2.6 + rnd * 2.2) + rnd * 40.0) * 0.22 * wind;
  p += along * sin(t * (3.1 + rnd * 1.7) + rnd * 17.0) * 0.025 * wind;

  float lead = clamp(0.5 - dot(position, along) * 0.12, 0.0, 1.0);
  float blow = clamp((blowing - rnd * 0.32 - lead * 0.22) / 0.46, 0.0, 1.0);
  vec3 scatter = vec3(hash11(rnd * 91.0) - 0.5, hash11(rnd * 37.0) - 0.35, hash11(rnd * 53.0) - 0.5);
  p += along * (7.0 + rnd * 7.0) * blow * blow + scatter * 5.0 * blow;
  p += (vec3(0.0, sin(blow * 3.0 + rnd * 9.0) * 0.6, 0.0) + across * sin(blow * 5.0 + rnd * 20.0) * 0.8) * blow;
  angle += blow * (5.0 + rnd * 9.0);
  size *= 1.0 - smoothstep(0.6, 1.0, blow);

  float since = frame.time - iFellAt;
  float regrown = since < REGROW ? 0.0 : easeOutBack(clamp((since - REGROW) / 0.5, 0.0, 1.0));
  size *= since < 0.0 ? 1.0 : regrown;

  vec2 corner = quadCorner(gl_VertexID);
  vec3 world = billboard(p, corner, angle, size);
  float shape = moss ? look.mossShape : look.crownShape;
  float dabShare = moss ? look.mossDabShare : look.crownDabShare;

  vUv = corner + 0.5;
  vShape = fract(rnd * 7.31) < dabShare ? DAB_CELL : shape;
  vNormal = iNormalAngle.xyz;
  vRnd = rnd;
  vExposure = iRndArrivalExposure.z;
  vShadowCoord = shadowCoord(world);
  gl_Position = project(world);
}
`);

  const leafCoverage = antialias
    ? `float alpha = crispAlpha(tex.a);
  if (alpha < 0.02) {
    discard;
  }`
    : `float alpha = 1.0;
  if (tex.a < 0.5) {
    discard;
  }`;

  const leafFragment = fragment(/* glsl */ `
in vec2 vUv;
in vec3 vNormal;
in float vRnd;
in float vExposure;
flat in float vShape;
in vec4 vShadowCoord;

void main() {
  bool moss = draw.variant > 0.5;
  vec4 tex = atlasTexel(vShape, vUv);
  ${leafCoverage}
  vec3 n = normalize(vNormal);
  float sun = leafSunlight(vShadowCoord, 0.0025);
  float light = 0.06 + 0.94 * smoothstep(-0.35, 0.7, dot(n, SUN_DIR));
  light *= mix(0.5, 1.0, sun);
  light *= mix(0.45, 1.0, smoothstep(0.2, 0.98, vExposure));
  light += max(n.y, 0.0) * 0.12;
  float vary = moss ? MOSS_VARY : CROWN_VARY;
  float k = clamp(light + (vRnd - 0.5) * vary + (tex.r - 0.9) * 0.6, 0.0, 1.0);
  vec3 base = moss ? rampColor(look.moss, k) : rampColor(look.crown, k);
  vec3 color = base * mix(vec3(1.0), look.sun.xyz, 0.15 * k);
  fragColor = vec4(dithered(color), alpha);
}
`);

  const leafDepthFragment = depthFragment(/* glsl */ `
${atlas}
in vec2 vUv;
flat in float vShape;

void main() {
  if (atlasTexel(vShape, vUv).a < 0.5) {
    discard;
  }
}
`);

  const barkVertex = vertex(/* glsl */ `
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aCenter;
layout(location = 3) in float aArrival;
layout(location = 4) in vec2 aUv;

out vec3 vNormal;
out vec2 vUv;
out vec4 vShadowCoord;

void main() {
  float grown = clamp((frame.grow * (1.0 + GROW_WIDTH) - aArrival) / GROW_WIDTH, 0.0, 1.0);
  grown = sqrt(grown) * (0.45 + 0.55 * clamp(frame.grow, 0.0, 1.0));
  vec3 p = aCenter + (aPosition - aCenter) * grown + windOffset(aCenter, WIND);
  vNormal = aNormal;
  vUv = aUv;
  vShadowCoord = shadowCoord(p + aNormal * 0.03);
  gl_Position = project(p);
}
`);

  const barkFragment = fragment(/* glsl */ `
in vec3 vNormal;
in vec2 vUv;
in vec4 vShadowCoord;

void main() {
  vec3 n = normalize(vNormal);
  float sun = sunlight(vShadowCoord, 0.0025);
  float light = smoothstep(-0.5, 0.45, dot(n, SUN_DIR)) * mix(0.35, 1.0, sun);
  vec3 color = mix(look.barkShade.xyz, look.bark.xyz, smoothstep(0.25, 0.7, light));
  vec2 cell = floor(vUv * 9.0);
  float ring = fract(vUv.y * 9.0 + hash12(cell) * 0.6);
  float lenticel = smoothstep(0.86, 0.9, ring) * (1.0 - smoothstep(0.95, 0.99, ring));
  color *= 1.0 - lenticel * 0.1;
  color *= 0.95 + hash12(vec2(floor(vUv.x * 14.0), floor(vUv.y * 3.0))) * 0.07;
  float snow = look.snow * smoothstep(0.25, 0.6, n.y);
  color = mix(color, look.snowColor.xyz * mix(0.82, 1.0, sun), snow);
  fragColor = vec4(dithered(color), 1.0);
}
`);

  const groundVertex = vertex(/* glsl */ `
out vec3 vWorld;
out vec4 vShadowCoord;

void main() {
  vec2 corner = quadCorner(gl_VertexID) * 80.0;
  vec3 world = vec3(corner.x, 0.0, corner.y);
  vWorld = world;
  vShadowCoord = shadowCoord(world);
  gl_Position = project(world);
}
`);

  const groundFragment = fragment(/* glsl */ `
in vec3 vWorld;
in vec4 vShadowCoord;

float smoothMin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

void main() {
  vec2 p = vWorld.xz;
  float r = length(p);
  float gravel = smoothstep(11.5, 6.5, r);
  vec3 color = mix(look.ground.xyz, look.gravel.xyz, gravel);

  if (r < 5.5) {
    float d = r - RAKE_RADIUS;
    for (int i = 0; i < 6; i++) {
      if (float(i) >= frame.stoneCount) {
        break;
      }
      vec4 stone = frame.stones[i];
      d = smoothMin(d, length((p - stone.xy) / vec2(1.0, stone.w)) - stone.z, 0.6);
    }
    float k = d / 0.2;
    float width = fwidth(k);
    float toLine = abs(fract(k) - 0.5) * 2.0;
    float groove = smoothstep(0.55 - width, 0.95 + width, 1.0 - toLine);
    groove *= 1.0 - smoothstep(0.35, 0.7, width);
    float near = smoothstep(5.5, 2.2, r) * smoothstep(0.0, 0.08, d);
    color = mix(color, look.rake.xyz, groove * near * RAKE_STRENGTH * 0.5);
  }
  color *= 1.0 + (hash12(floor(p * 55.0)) - 0.5) * 0.035 * gravel;

  if (r < 15.0) {
    float lit = sunlight(vShadowCoord, 0.001);
    color = mix(color, look.shadow.xyz, (1.0 - lit) * SHADOW_STRENGTH * smoothstep(15.0, 9.0, r));
  }
  fragColor = vec4(dithered(color), 1.0);
}
`);

  const solidVertex = vertex(/* glsl */ `
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;

out vec3 vNormal;
out vec3 vWorld;
out vec4 vShadowCoord;

void main() {
  vec3 world = (draw.model * vec4(aPosition, 1.0)).xyz;
  vec3 normal = normalize(mat3(draw.model) * aNormal);
  vNormal = normal;
  vWorld = world;
  vShadowCoord = shadowCoord(world + normal * 0.05);
  gl_Position = project(world);
}
`);

  const solidFragment = fragment(/* glsl */ `
in vec3 vNormal;
in vec3 vWorld;
in vec4 vShadowCoord;

void main() {
  bool stone = draw.variant > 0.5;
  vec3 lit = stone ? look.rock.xyz : look.moss[1].xyz;
  vec3 dark = stone ? look.rockShade.xyz : look.moss[0].xyz;
  float grain = stone ? 0.05 : 0.08;
  vec3 n = normalize(vNormal);
  float sun = sunlight(vShadowCoord, 0.0025);
  float light = smoothstep(-0.2, 0.55, dot(n, SUN_DIR)) * mix(0.3, 1.0, sun);
  vec3 color = mix(dark, lit, smoothstep(0.15, 0.75, light));
  color *= 1.0 + (hash12(floor(vWorld.xz * 30.0 + vWorld.y * 17.0)) - 0.5) * grain;
  float snow = (stone ? look.snow : 0.0) * smoothstep(0.35, 0.7, n.y);
  color = mix(color, look.snowColor.xyz * mix(0.8, 1.0, sun), snow);
  fragColor = vec4(dithered(color), 1.0);
}
`);

  const fallVertex = vertex(/* glsl */ `
layout(location = 0) in vec3 aStart;
layout(location = 1) in vec3 aVelocity;
layout(location = 2) in vec3 aTerminal;
layout(location = 3) in vec4 aTiming;
layout(location = 4) in vec4 aLook;

out vec2 vUv;
out float vRnd;
out float vAlpha;
out float vLanded;
out float vFlip;
flat out float vShape;
out float vAmbient;
out vec4 vShadowCoord;

void main() {
  float spawn = aTiming.x;
  float airTime = aTiming.y;
  float restTime = aTiming.z;
  float seed = aTiming.w;
  float size = aLook.x;
  float spin = aLook.y;
  float rnd = aLook.z;
  float ambient = step(0.5, aLook.w);
  float snow = step(1.5, aLook.w);
  float shown = mix(1.0, mix(1.0 - look.snow, look.snow, snow), ambient);

  float age = frame.time - spawn;
  float life = airTime + restTime;
  float tf = clamp(age, 0.0, airTime);
  float e = (1.0 - exp(-DRAG * tf)) / DRAG;
  vec3 p = aStart + aVelocity * e + aTerminal * (tf - e);
  vec3 across = vec3(1.0, 0.0, 0.0);
  vec3 side = vec3(-aTerminal.z, 0.0, aTerminal.x);
  if (dot(side, side) > 1e-6) {
    across = normalize(side);
  }
  float flutter = smoothstep(0.0, 0.8, tf) * (1.0 - smoothstep(airTime - 0.6, airTime, tf));
  p += across * sin(tf * (1.8 + fract(seed * 5.1)) + seed * 30.0) * mix(0.3, 0.12, snow) * flutter;

  float landed = smoothstep(airTime, airTime + 0.18, age);
  float lift = length(p.xz) < MOUND_RADIUS ? 0.07 : 0.012;
  p.y = max(p.y, moundHeight(p.xz) + mix(0.0, lift + fract(seed * 91.0) * 0.008, landed));

  float alpha = step(0.0, age) * step(age, life);
  float fadeOut = mix(2.5, 1.2, ambient);
  alpha *= smoothstep(0.0, 0.3, age) * (1.0 - smoothstep(life - fadeOut, life, age));
  alpha *= mix(1.0, 0.75, landed * ambient) * frame.fade * shown;

  float angle = spin * tf + seed * 6.28;
  float flip = cos(tf * (2.0 + spin));
  vec2 corner = quadCorner(gl_VertexID);
  vec2 uv = corner + 0.5;
  corner.x *= mix(abs(flip) * 0.85 + 0.15, 1.0, landed);
  float sz = size * LEAF_SCALE * step(0.001, alpha);

  vec3 airborne = billboard(p, corner, angle, sz);
  vec3 squashed = billboard(p, corner * vec2(1.0, 0.42), angle, sz);
  vec3 tangentX = vec3(cos(angle), 0.0, sin(angle));
  vec3 tangentZ = normalize(vec3(-sin(angle), 0.0, cos(angle)) + vec3(0.0, 0.5, 0.0));
  vec3 lying = p + (tangentX * corner.x + tangentZ * corner.y) * sz;
  vec3 world = mix(airborne, mix(lying, squashed, ambient), landed);

  vUv = uv;
  vRnd = rnd;
  vAlpha = alpha;
  vLanded = landed;
  vFlip = abs(flip);
  vAmbient = ambient;
  vShape = ambient < 0.5 && fract(rnd * 7.31) < look.crownDabShare ? DAB_CELL : look.crownShape;
  vShadowCoord = shadowCoord(world);
  gl_Position = project(world);
}
`);

  const fallFragment = fragment(/* glsl */ `
in vec2 vUv;
in float vRnd;
in float vAlpha;
in float vLanded;
in float vFlip;
flat in float vShape;
in float vAmbient;
in vec4 vShadowCoord;

void main() {
  vec4 tex = atlasTexel(vShape, vUv);
  float alpha = crispAlpha(tex.a) * vAlpha;
  if (alpha < 0.02) {
    discard;
  }
  vec3 color;
  if (vAmbient > 0.5) {
    float pick = fract(vRnd * 13.7);
    vec3 base = look.crown[3].xyz;
    if (pick < 0.34) {
      base = look.crown[0].xyz;
    } else if (pick < 0.62) {
      base = look.crown[1].xyz;
    } else if (pick < 0.84) {
      base = look.crown[2].xyz;
    }
    float shade = mix(0.82 + 0.18 * vFlip, 0.9, vLanded);
    color = base * shade * mix(0.88, 1.0, tex.r);
  } else {
    float sun = leafSunlight(vShadowCoord, 0.0025);
    float k = 0.5 + (vRnd - 0.5) * 0.7 + (tex.r - 0.9) * 0.6 + (vFlip - 0.5) * 0.25 * (1.0 - vLanded);
    k = clamp(k, 0.0, 1.0) * mix(0.55, 1.0, sun * mix(1.0, 0.9, vLanded));
    color = rampColor(look.crown, k);
  }
  fragColor = vec4(dithered(color), alpha);
}
`);

  const fullscreenVertex = `${header}
void main() {
  vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}
`;

  const wipeFragment = `${header}
uniform sampler2D incoming;
out vec4 fragColor;

const float RIM = 0.012;
const vec3 RIM_COLOR = vec3(1.0);

void main() {
  vec2 size = vec2(textureSize(incoming, 0));
  vec2 uv = gl_FragCoord.xy / size;
  vec3 next = texelFetch(incoming, ivec2(gl_FragCoord.xy), 0).rgb;
  vec2 q = (uv - frame.origin) * vec2(frame.aspect, 1.0);
  float theta = atan(q.y, q.x);
  float phase = frame.wipe * 4.0;
  float wobble = 1.0 + 0.045 * sin(theta * 5.0 + phase) + 0.025 * sin(theta * 9.0 - phase * 1.7 + 1.1) + 0.012 * sin(theta * 17.0 + phase * 2.3);
  float edge = length(q) * wobble;
  float front = frame.wipe * (length(vec2(frame.aspect, 1.0)) * 1.15 + RIM * 2.0);
  float aa = 1.5 * fwidth(edge);
  float inside = 1.0 - smoothstep(front - RIM - aa, front - RIM + aa, edge);
  float rim = smoothstep(front - RIM - aa, front - RIM + aa, edge) * (1.0 - smoothstep(front - aa, front + aa, edge));
  float ahead = (1.0 - smoothstep(front, front + 0.03, edge)) * (1.0 - rim) * (1.0 - inside);
  float outgoing = (1.0 - 0.12 * ahead) * (1.0 - inside) * (1.0 - rim);
  fragColor = vec4(next * inside * (1.0 - rim) + RIM_COLOR * rim, outgoing);
}
`;

  const emptyFragment = depthFragment("void main() {}\n");

  return {
    leaf: { vertex: leafVertex, fragment: leafFragment },
    leafDepth: { vertex: leafVertex, fragment: leafDepthFragment },
    bark: { vertex: barkVertex, fragment: barkFragment },
    barkDepth: { vertex: barkVertex, fragment: emptyFragment },
    ground: { vertex: groundVertex, fragment: groundFragment },
    solid: { vertex: solidVertex, fragment: solidFragment },
    solidDepth: { vertex: solidVertex, fragment: emptyFragment },
    fall: { vertex: fallVertex, fragment: fallFragment },
    wipe: { vertex: fullscreenVertex, fragment: wipeFragment },
  };
}
