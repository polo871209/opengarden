import { FALL_FLOATS } from "./falling.ts";
import type { Look } from "./look.ts";
import {
  BARK_FLOATS,
  LEAF_FLOATS,
  type Mesh,
  NEVER,
  SOLID_FLOATS,
} from "./meshes.ts";
import {
  CAMERA_FLOATS,
  DRAW_FLOATS,
  FRAME_FLOATS,
  LOOK_FLOATS,
  SHADOW_TILE,
  sceneShader,
  shadowRangeShader,
  wipeShader,
} from "./shaders.ts";
import { SHADOW_SIZE, SUN_DIR } from "./world.ts";

const SAMPLES = 4;
const DEPTH_FORMAT = "depth24plus";
const SHADOW_FORMAT = "depth32float";
const SHADOW_RANGE_FORMAT = "rg32float";
const QUAD_VERTICES = 6;
const SORT_BUCKETS = 4096;

/** RGBA pixels, 4 bytes each, rows top first. */
export interface Image {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>;
}

interface Solid {
  mesh: Mesh;
  /** Column-major model matrix. */
  model: ArrayLike<number>;
  variant: number;
}

export interface SceneSetup {
  atlas: Image;
  /** {@link LEAF_FLOATS} floats per moss leaf. */
  moss: Float32Array<ArrayBuffer>;
  solids: Solid[];
  fallCapacity: number;
}

interface Destroyable {
  destroy(): void;
}

interface Point {
  x: number;
  y: number;
  z: number;
}

interface Section {
  at: number;
  floats: number;
}

interface FrameState {
  frame: Float32Array<ArrayBuffer>;
  eye: Float32Array<ArrayBuffer>;
  sun: Float32Array<ArrayBuffer>;
  viewer: Point;
  current: Look;
  incoming: Look | null;
}

export interface Renderer {
  resize(width: number, height: number): void;
  setTree(bark: Mesh, leaves: Float32Array<ArrayBuffer>): void;
  setGone(gone: Float32Array<ArrayBuffer>): void;
  setFalling(changed: Float32Array<ArrayBuffer>, firstLeaf: number): void;
  render(
    target: GPUTextureView,
    state: FrameState,
    encoder?: GPUCommandEncoder,
  ): void;
  dispose(): void;
}

const vec4 = (v: Point) => [v.x, v.y, v.z, 0];

function packLook(look: Look, out: Float32Array, at: number) {
  out.set(
    [
      ...look.crown.flatMap(vec4),
      ...look.moss.flatMap(vec4),
      ...[
        look.ground,
        look.gravel,
        look.rake,
        look.shadow,
        look.bark,
        look.barkShade,
        look.rock,
        look.rockShade,
        look.sun,
        look.snowColor,
      ].flatMap(vec4),
      look.crownShape,
      look.crownDabShare,
      look.mossShape,
      look.mossDabShare,
      look.snow,
    ],
    at,
  );
}

function mipLevels(image: Image): Image[] {
  const levels = [image];
  let level = image;
  while (level.width > 1 || level.height > 1) {
    const width = Math.max(1, level.width >> 1);
    const height = Math.max(1, level.height >> 1);
    const data = new Uint8Array(width * height * 4);
    const at = (x: number, y: number, c: number) =>
      level.data[
        (Math.min(y, level.height - 1) * level.width +
          Math.min(x, level.width - 1)) *
          4 +
          c
      ];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 4; c++)
          data[(y * width + x) * 4 + c] =
            (at(2 * x, 2 * y, c) +
              at(2 * x + 1, 2 * y, c) +
              at(2 * x, 2 * y + 1, c) +
              at(2 * x + 1, 2 * y + 1, c) +
              2) >>
            2;
    level = { width, height, data };
    levels.push(level);
  }
  return levels;
}

function nearestFirst(
  leaves: Float32Array,
  distance: (x: number, y: number, z: number) => number,
): Uint32Array<ArrayBuffer> {
  const count = leaves.length / LEAF_FLOATS;
  const distances = new Float64Array(count);
  let near = Infinity;
  let far = -Infinity;
  for (let i = 0; i < count; i++) {
    const at = i * LEAF_FLOATS;
    const d = distance(leaves[at], leaves[at + 1], leaves[at + 2]);
    distances[i] = d;
    near = Math.min(near, d);
    far = Math.max(far, d);
  }
  const scale = (SORT_BUCKETS - 1) / Math.max(far - near, 1e-9);
  const buckets = new Uint16Array(count);
  const starts = new Uint32Array(SORT_BUCKETS + 1);
  for (let i = 0; i < count; i++) {
    buckets[i] = Math.floor((distances[i] - near) * scale);
    starts[buckets[i] + 1]++;
  }
  for (let b = 1; b <= SORT_BUCKETS; b++) starts[b] += starts[b - 1];
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[starts[buckets[i]]++] = i;
  return order;
}

const attributes = (...formats: GPUVertexFormat[]): GPUVertexAttribute[] => {
  const bytes: Record<string, number> = {
    float32: 4,
    float32x2: 8,
    float32x3: 12,
    float32x4: 16,
  };
  let offset = 0;
  return formats.map((format, shaderLocation) => {
    const attribute = { format, offset, shaderLocation };
    offset += bytes[format];
    return attribute;
  });
};

export function createRenderer(
  device: GPUDevice,
  format: GPUTextureFormat,
  setup: SceneSetup,
): Renderer {
  const { UNIFORM, VERTEX, INDEX, STORAGE, COPY_DST } = GPUBufferUsage;
  const owned: Destroyable[] = [];
  const buffer = (
    usage: number,
    data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>,
    into = owned,
  ) => {
    const created = device.createBuffer({
      size: Math.max(16, Math.ceil(data.byteLength / 4) * 4),
      usage: usage | COPY_DST,
    });
    device.queue.writeBuffer(created, 0, data);
    into.push(created);
    return created;
  };

  const levels = mipLevels(setup.atlas);
  const atlas = device.createTexture({
    size: [setup.atlas.width, setup.atlas.height],
    format: "rgba8unorm",
    mipLevelCount: levels.length,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  owned.push(atlas);
  for (const [mipLevel, level] of levels.entries())
    device.queue.writeTexture(
      { texture: atlas, mipLevel },
      level.data,
      { bytesPerRow: level.width * 4 },
      [level.width, level.height],
    );

  const shadowMap = device.createTexture({
    size: [SHADOW_SIZE, SHADOW_SIZE],
    format: SHADOW_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  owned.push(shadowMap);
  const shadowView = shadowMap.createView();
  const shadowRange = device.createTexture({
    size: [SHADOW_SIZE / SHADOW_TILE, SHADOW_SIZE / SHADOW_TILE],
    format: SHADOW_RANGE_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  owned.push(shadowRange);
  const shadowRangeView = shadowRange.createView();

  const all = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const uniformEntry = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: all,
    buffer: {},
  });
  const storageEntry = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.VERTEX,
    buffer: { type: "read-only-storage" },
  });
  const textureEntry = (
    binding: number,
    sampleType: GPUTextureSampleType,
  ): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    texture: { sampleType },
  });
  const cameraLayout = device.createBindGroupLayout({
    entries: [uniformEntry(0)],
  });
  const sceneLayout = device.createBindGroupLayout({
    entries: [
      uniformEntry(0),
      uniformEntry(1),
      textureEntry(2, "float"),
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const drawLayout = device.createBindGroupLayout({
    entries: [uniformEntry(0)],
  });
  const leafLayout = device.createBindGroupLayout({
    entries: [
      uniformEntry(0),
      storageEntry(1),
      storageEntry(2),
      storageEntry(3),
    ],
  });
  const shadowLayout = device.createBindGroupLayout({
    entries: [
      textureEntry(0, "depth"),
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "comparison" },
      },
      textureEntry(2, "unfilterable-float"),
    ],
  });
  const shadowRangeLayout = device.createBindGroupLayout({
    entries: [
      textureEntry(0, "depth"),
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "non-filtering" },
      },
    ],
  });
  const wipeLayout = device.createBindGroupLayout({
    entries: [uniformEntry(0), textureEntry(1, "unfilterable-float")],
  });

  const align = device.limits.minUniformBufferOffsetAlignment / 4;
  let uniformFloats = 0;
  const section = (floats: number): Section => {
    const at = uniformFloats;
    uniformFloats += Math.ceil(floats / align) * align;
    return { at, floats };
  };
  const sections = {
    frame: section(FRAME_FLOATS),
    eye: section(CAMERA_FLOATS),
    sun: section(CAMERA_FLOATS),
    current: section(LOOK_FLOATS),
    incoming: section(LOOK_FLOATS),
  };
  const uniformData = new Float32Array(uniformFloats);
  const uniforms = buffer(UNIFORM, uniformData);
  const binding = (part: Section) => ({
    buffer: uniforms,
    offset: part.at * 4,
    size: part.floats * 4,
  });
  const cameraGroup = (part: Section) =>
    device.createBindGroup({
      layout: cameraLayout,
      entries: [{ binding: 0, resource: binding(part) }],
    });
  const eye = cameraGroup(sections.eye);
  const sun = cameraGroup(sections.sun);
  const atlasSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    maxAnisotropy: 4,
  });
  const sceneGroup = (look: Section) =>
    device.createBindGroup({
      layout: sceneLayout,
      entries: [
        { binding: 0, resource: binding(sections.frame) },
        { binding: 1, resource: binding(look) },
        { binding: 2, resource: atlas.createView() },
        { binding: 3, resource: atlasSampler },
      ],
    });
  const scenes = {
    current: sceneGroup(sections.current),
    incoming: sceneGroup(sections.incoming),
  };
  const shadowGroup = device.createBindGroup({
    layout: shadowLayout,
    entries: [
      { binding: 0, resource: shadowView },
      {
        binding: 1,
        resource: device.createSampler({
          compare: "less-equal",
          magFilter: "linear",
          minFilter: "linear",
        }),
      },
      { binding: 2, resource: shadowRangeView },
    ],
  });
  const shadowRangeGroup = device.createBindGroup({
    layout: shadowRangeLayout,
    entries: [
      { binding: 0, resource: shadowView },
      { binding: 1, resource: device.createSampler() },
    ],
  });
  const drawBuffer = (model: ArrayLike<number>, variant: number) => {
    const data = new Float32Array(DRAW_FLOATS);
    data.set(model);
    data[16] = variant;
    return buffer(UNIFORM, data);
  };
  const drawGroup = (draw: GPUBuffer) =>
    device.createBindGroup({
      layout: drawLayout,
      entries: [{ binding: 0, resource: { buffer: draw } }],
    });
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const crownDraw = drawBuffer(identity, 0);
  const mossDraw = drawBuffer(identity, 1);
  const plain = drawGroup(crownDraw);

  const sceneModule = device.createShaderModule({ code: sceneShader });
  const pipelineLayout = (draw: GPUBindGroupLayout, shadows: boolean) =>
    device.createPipelineLayout({
      bindGroupLayouts: [
        cameraLayout,
        sceneLayout,
        draw,
        ...(shadows ? [shadowLayout] : []),
      ],
    });
  const layouts = {
    main: pipelineLayout(drawLayout, true),
    leaf: pipelineLayout(leafLayout, true),
    depth: pipelineLayout(drawLayout, false),
    leafDepth: pipelineLayout(leafLayout, false),
  };

  const barkBuffers: GPUVertexBufferLayout[] = [
    {
      arrayStride: BARK_FLOATS * 4,
      attributes: attributes(
        "float32x3",
        "float32x3",
        "float32x3",
        "float32",
        "float32x2",
      ),
    },
  ];
  const solidBuffers: GPUVertexBufferLayout[] = [
    {
      arrayStride: SOLID_FLOATS * 4,
      attributes: attributes("float32x3", "float32x3"),
    },
  ];
  const fallBuffers: GPUVertexBufferLayout[] = [
    {
      arrayStride: FALL_FLOATS * 4,
      stepMode: "instance",
      attributes: attributes(
        "float32x3",
        "float32x3",
        "float32x3",
        "float32x4",
        "float32x4",
      ),
    },
  ];

  const scenePipeline = (
    name: string,
    buffers: GPUVertexBufferLayout[],
    options: {
      layout?: GPUPipelineLayout;
      cullMode?: GPUCullMode;
      alphaToCoverage?: boolean;
      blend?: GPUBlendState;
    } = {},
  ) =>
    device.createRenderPipeline({
      layout: options.layout ?? layouts.main,
      vertex: { module: sceneModule, entryPoint: `${name}Vertex`, buffers },
      fragment: {
        module: sceneModule,
        entryPoint: `${name}Fragment`,
        targets: [{ format, blend: options.blend }],
      },
      primitive: { cullMode: options.cullMode ?? "back" },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: "less-equal",
        depthWriteEnabled: !options.blend,
      },
      multisample: {
        count: SAMPLES,
        alphaToCoverageEnabled: options.alphaToCoverage ?? false,
      },
    });
  const depthPipeline = (
    name: string,
    buffers: GPUVertexBufferLayout[],
    cullMode: GPUCullMode,
    layout: GPUPipelineLayout,
    fragment?: string,
  ) =>
    device.createRenderPipeline({
      layout,
      vertex: { module: sceneModule, entryPoint: `${name}Vertex`, buffers },
      fragment: fragment
        ? { module: sceneModule, entryPoint: fragment, targets: [] }
        : undefined,
      primitive: { cullMode },
      depthStencil: {
        format: SHADOW_FORMAT,
        depthCompare: "less-equal",
        depthWriteEnabled: true,
      },
    });
  const fullscreenPipeline = (
    code: string,
    entryPoint: string,
    layout: GPUBindGroupLayout,
    target: GPUColorTargetState,
  ) => {
    const module = device.createShaderModule({ code });
    return device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "fullscreenVertex" },
      fragment: { module, entryPoint, targets: [target] },
    });
  };

  const pipelines = {
    leaf: scenePipeline("leaf", [], {
      layout: layouts.leaf,
      cullMode: "none",
      alphaToCoverage: true,
    }),
    bark: scenePipeline("bark", barkBuffers),
    ground: scenePipeline("ground", [], { cullMode: "none" }),
    solid: scenePipeline("solid", solidBuffers),
    fall: scenePipeline("fall", fallBuffers, {
      cullMode: "none",
      blend: {
        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      },
    }),
    leafDepth: depthPipeline(
      "leaf",
      [],
      "none",
      layouts.leafDepth,
      "leafDepthFragment",
    ),
    barkDepth: depthPipeline("bark", barkBuffers, "back", layouts.depth),
    solidDepth: depthPipeline("solid", solidBuffers, "back", layouts.depth),
    shadowRange: fullscreenPipeline(
      shadowRangeShader,
      "shadowRangeFragment",
      shadowRangeLayout,
      { format: SHADOW_RANGE_FORMAT },
    ),
    wipe: fullscreenPipeline(wipeShader, "wipeFragment", wipeLayout, {
      format,
      blend: {
        color: { srcFactor: "one", dstFactor: "src-alpha" },
        alpha: { srcFactor: "zero", dstFactor: "one" },
      },
    }),
  };

  interface Geometry {
    vertices: GPUBuffer;
    indices?: GPUBuffer;
    count: number;
  }
  const geometry = (
    mesh: Mesh,
    floats: number,
    into: Destroyable[],
  ): Geometry => ({
    vertices: buffer(VERTEX, mesh.vertices, into),
    indices: mesh.indices && buffer(INDEX, mesh.indices, into),
    count: mesh.indices?.length ?? mesh.vertices.length / floats,
  });

  interface LeafSet {
    leaves: Float32Array<ArrayBuffer>;
    count: number;
    gone: GPUBuffer;
    eyeOrder: GPUBuffer;
    sortedFor?: Point;
    eye: GPUBindGroup;
    group(order: GPUBuffer): GPUBindGroup;
  }
  const leafSet = (
    leaves: Float32Array<ArrayBuffer>,
    draw: GPUBuffer,
    into: Destroyable[],
  ): LeafSet => {
    const count = leaves.length / LEAF_FLOATS;
    const data = buffer(
      STORAGE,
      count ? leaves : new Float32Array(LEAF_FLOATS),
      into,
    );
    const gone = buffer(STORAGE, new Float32Array(count).fill(NEVER), into);
    const group = (order: GPUBuffer) =>
      device.createBindGroup({
        layout: leafLayout,
        entries: [
          { binding: 0, resource: { buffer: draw } },
          { binding: 1, resource: { buffer: data } },
          { binding: 2, resource: { buffer: gone } },
          { binding: 3, resource: { buffer: order } },
        ],
      });
    const eyeOrder = buffer(STORAGE, new Uint32Array(count), into);
    return { leaves, count, gone, eyeOrder, eye: group(eyeOrder), group };
  };
  const sortForViewer = (set: LeafSet, viewer: Point) => {
    const last = set.sortedFor;
    if (
      last &&
      last.x === viewer.x &&
      last.y === viewer.y &&
      last.z === viewer.z
    )
      return;
    set.sortedFor = { x: viewer.x, y: viewer.y, z: viewer.z };
    device.queue.writeBuffer(
      set.eyeOrder,
      0,
      nearestFirst(
        set.leaves,
        (x, y, z) =>
          (x - viewer.x) ** 2 + (y - viewer.y) ** 2 + (z - viewer.z) ** 2,
      ),
    );
  };

  const moss = leafSet(setup.moss, mossDraw, owned);
  const solids = setup.solids.map((solid) => ({
    geometry: geometry(solid.mesh, SOLID_FLOATS, owned),
    draw: drawGroup(drawBuffer(solid.model, solid.variant)),
  }));
  const fall = buffer(
    VERTEX,
    new Float32Array(setup.fallCapacity * FALL_FLOATS),
  );
  let tree:
    | {
        bark: Geometry;
        crown: LeafSet;
        sunward: GPUBindGroup;
        buffers: Destroyable[];
      }
    | undefined;

  let targets:
    | {
        msaa: GPUTextureView;
        depth: GPUTextureView;
        incoming: GPUTextureView;
        wipe: GPUBindGroup;
        textures: GPUTexture[];
      }
    | undefined;

  const destroyTargets = () => {
    for (const texture of targets?.textures ?? []) texture.destroy();
  };
  const destroyTree = () => {
    for (const created of tree?.buffers ?? []) created.destroy();
  };

  const drawGeometry = (pass: GPURenderBundleEncoder, shape: Geometry) => {
    pass.setVertexBuffer(0, shape.vertices);
    if (shape.indices) {
      pass.setIndexBuffer(shape.indices, "uint32");
      pass.drawIndexed(shape.count);
    } else pass.draw(shape.count);
  };
  const drawLeaves = (
    pass: GPURenderBundleEncoder,
    leaves: LeafSet,
    group: GPUBindGroup,
  ) => {
    pass.setBindGroup(2, group);
    pass.draw(QUAD_VERTICES, leaves.count);
  };

  const recordShadows = () => {
    const pass = device.createRenderBundleEncoder({
      colorFormats: [],
      depthStencilFormat: SHADOW_FORMAT,
    });
    pass.setBindGroup(0, sun);
    pass.setBindGroup(1, scenes.current);
    if (tree) {
      pass.setBindGroup(2, plain);
      pass.setPipeline(pipelines.barkDepth);
      drawGeometry(pass, tree.bark);
      pass.setPipeline(pipelines.leafDepth);
      drawLeaves(pass, tree.crown, tree.sunward);
    }
    pass.setPipeline(pipelines.solidDepth);
    for (const solid of solids) {
      pass.setBindGroup(2, solid.draw);
      drawGeometry(pass, solid.geometry);
    }
    return pass.finish();
  };

  const recordScene = (scene: GPUBindGroup) => {
    const pass = device.createRenderBundleEncoder({
      colorFormats: [format],
      depthStencilFormat: DEPTH_FORMAT,
      sampleCount: SAMPLES,
    });
    pass.setBindGroup(0, eye);
    pass.setBindGroup(1, scene);
    pass.setBindGroup(2, plain);
    pass.setBindGroup(3, shadowGroup);
    pass.setPipeline(pipelines.ground);
    pass.draw(QUAD_VERTICES);
    if (tree) {
      pass.setPipeline(pipelines.bark);
      drawGeometry(pass, tree.bark);
      pass.setPipeline(pipelines.leaf);
      drawLeaves(pass, tree.crown, tree.crown.eye);
    }
    pass.setPipeline(pipelines.solid);
    for (const solid of solids) {
      pass.setBindGroup(2, solid.draw);
      drawGeometry(pass, solid.geometry);
    }
    pass.setPipeline(pipelines.leaf);
    drawLeaves(pass, moss, moss.eye);
    pass.setBindGroup(2, plain);
    pass.setPipeline(pipelines.fall);
    pass.setVertexBuffer(0, fall);
    pass.draw(QUAD_VERTICES, setup.fallCapacity);
    return pass.finish();
  };

  const recordBundles = () => ({
    shadows: recordShadows(),
    current: recordScene(scenes.current),
    incoming: recordScene(scenes.incoming),
  });
  let bundles = recordBundles();

  const castShadows = (encoder: GPUCommandEncoder) => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: shadowView,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.executeBundles([bundles.shadows]);
    pass.end();

    const range = encoder.beginRenderPass({
      colorAttachments: [
        { view: shadowRangeView, loadOp: "clear", storeOp: "store" },
      ],
    });
    range.setPipeline(pipelines.shadowRange);
    range.setBindGroup(0, shadowRangeGroup);
    range.draw(3);
    range.end();
  };

  const drawScene = (
    encoder: GPUCommandEncoder,
    resolveTarget: GPUTextureView,
    scene: GPURenderBundle,
    clear: Look["ground"],
  ) => {
    if (!targets) return;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targets.msaa,
          resolveTarget,
          clearValue: [clear.x, clear.y, clear.z, 1],
          loadOp: "clear",
          storeOp: "discard",
        },
      ],
      depthStencilAttachment: {
        view: targets.depth,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    pass.executeBundles([scene]);
    pass.end();
  };

  return {
    resize(width, height) {
      destroyTargets();
      const textures: GPUTexture[] = [];
      const texture = (descriptor: GPUTextureDescriptor) => {
        const created = device.createTexture(descriptor);
        textures.push(created);
        return created.createView();
      };
      // Browsers without transient attachments read the flag as undefined, which `|` turns into 0.
      const transient =
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TRANSIENT_ATTACHMENT;
      const incoming = texture({
        size: [width, height],
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      targets = {
        msaa: texture({
          size: [width, height],
          format,
          sampleCount: SAMPLES,
          usage: transient,
        }),
        depth: texture({
          size: [width, height],
          format: DEPTH_FORMAT,
          sampleCount: SAMPLES,
          usage: transient,
        }),
        incoming,
        wipe: device.createBindGroup({
          layout: wipeLayout,
          entries: [
            { binding: 0, resource: binding(sections.frame) },
            { binding: 1, resource: incoming },
          ],
        }),
        textures,
      };
    },

    setTree(bark, leaves) {
      destroyTree();
      const buffers: Destroyable[] = [];
      const crown = leafSet(leaves, crownDraw, buffers);
      const sunOrder = nearestFirst(
        leaves,
        (x, y, z) => -(x * SUN_DIR[0] + y * SUN_DIR[1] + z * SUN_DIR[2]),
      );
      tree = {
        bark: geometry(bark, BARK_FLOATS, buffers),
        crown,
        sunward: crown.group(buffer(STORAGE, sunOrder, buffers)),
        buffers,
      };
      bundles = recordBundles();
    },

    setGone(gone) {
      if (tree) device.queue.writeBuffer(tree.crown.gone, 0, gone);
    },

    setFalling(changed, firstLeaf) {
      device.queue.writeBuffer(fall, firstLeaf * FALL_FLOATS * 4, changed);
    },

    render(target, state, into) {
      if (!targets) return;
      uniformData.set(state.frame, sections.frame.at);
      uniformData.set(state.eye, sections.eye.at);
      uniformData.set(state.sun, sections.sun.at);
      packLook(state.current, uniformData, sections.current.at);
      if (state.incoming)
        packLook(state.incoming, uniformData, sections.incoming.at);
      device.queue.writeBuffer(uniforms, 0, uniformData);
      sortForViewer(moss, state.viewer);
      if (tree) sortForViewer(tree.crown, state.viewer);

      const encoder = into ?? device.createCommandEncoder();
      castShadows(encoder);
      drawScene(encoder, target, bundles.current, state.current.ground);
      if (state.incoming) {
        drawScene(
          encoder,
          targets.incoming,
          bundles.incoming,
          state.incoming.ground,
        );
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: target, loadOp: "load", storeOp: "store" },
          ],
        });
        pass.setPipeline(pipelines.wipe);
        pass.setBindGroup(0, targets.wipe);
        pass.draw(3);
        pass.end();
      }
      if (!into) device.queue.submit([encoder.finish()]);
    },

    dispose() {
      destroyTargets();
      destroyTree();
      for (const resource of owned) resource.destroy();
    },
  };
}
