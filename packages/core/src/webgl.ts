import { FALL_FLOATS } from "./falling.ts";
import {
  createSimulation,
  type GardenOptions,
  type WebGLGarden,
} from "./garden.ts";
import { BLOCKS, glslPrograms, type Program, UNITS } from "./glsl.ts";
import type { Look } from "./look.ts";
import {
  BARK_FLOATS,
  LEAF_FLOATS,
  type Mesh,
  NEVER,
  SOLID_FLOATS,
} from "./meshes.ts";
import {
  fromViewer,
  mipLevels,
  nearestFirst,
  type Point,
  packLook,
  type Renderer,
  type SceneSetup,
  shadowClock,
} from "./renderer.ts";
import {
  CAMERA_FLOATS,
  DRAW_FLOATS,
  FRAME_FLOATS,
  LOOK_FLOATS,
} from "./uniforms.ts";

const QUAD_VERTICES = 6;

/** A vertex attribute: its location, its float count, and its float offset in the vertex. */
type Attribute = [location: number, size: number, offset: number];

interface Geometry {
  vao: WebGLVertexArrayObject;
  count: number;
  indexed: boolean;
}

interface LeafSet {
  leaves: Float32Array<ArrayBuffer>;
  count: number;
  gone: Float32Array<ArrayBuffer>;
  order: Uint32Array<ArrayBuffer>;
  sortedFor?: Point;
  vao: WebGLVertexArrayObject;
  data: WebGLBuffer;
  goneBuffer: WebGLBuffer;
}

function createWebGLRenderer(
  gl: WebGL2RenderingContext,
  setup: SceneSetup,
): Renderer<[]> {
  const { settings } = setup;
  const antialias = (gl.getParameter(gl.SAMPLES) as number) > 1;
  const shadowsDue = shadowClock(settings);
  const cleanup: (() => void)[] = [];

  const compile = ({ vertex, fragment }: Program) => {
    const shader = (type: number, source: string) => {
      const created = gl.createShader(type);
      if (!created) throw new Error("WebGL could not create a shader");
      gl.shaderSource(created, source);
      gl.compileShader(created);
      return created;
    };
    const vs = shader(gl.VERTEX_SHADER, vertex);
    const fs = shader(gl.FRAGMENT_SHADER, fragment);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = [vs, fs]
        .map((s) => gl.getShaderInfoLog(s))
        .concat(gl.getProgramInfoLog(program))
        .filter(Boolean)
        .join("\n");
      throw new Error(`WebGL could not link a garden shader:\n${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    for (const [name, binding] of Object.entries(BLOCKS)) {
      const index = gl.getUniformBlockIndex(program, name);
      if (index !== gl.INVALID_INDEX)
        gl.uniformBlockBinding(program, index, binding);
    }
    gl.useProgram(program);
    for (const [name, unit] of Object.entries(UNITS)) {
      const location = gl.getUniformLocation(program, name);
      if (location) gl.uniform1i(location, unit);
    }
    cleanup.push(() => gl.deleteProgram(program));
    return program;
  };

  const sources = glslPrograms(settings, antialias);
  const programs = {
    leaf: compile(sources.leaf),
    leafDepth: compile(sources.leafDepth),
    bark: compile(sources.bark),
    barkDepth: compile(sources.barkDepth),
    ground: compile(sources.ground),
    solid: compile(sources.solid),
    solidDepth: compile(sources.solidDepth),
    fall: compile(sources.fall),
    wipe: compile(sources.wipe),
  };

  const buffer = (
    target: number,
    data: ArrayBufferView<ArrayBuffer> | number,
    usage: number = gl.STATIC_DRAW,
    into = cleanup,
  ) => {
    const created = gl.createBuffer();
    gl.bindBuffer(target, created);
    if (typeof data === "number") gl.bufferData(target, data, usage);
    else gl.bufferData(target, data, usage);
    into.push(() => gl.deleteBuffer(created));
    return created;
  };
  const uniformBlock = (floats: number, data?: Float32Array<ArrayBuffer>) =>
    buffer(gl.UNIFORM_BUFFER, data ?? floats * 4, gl.DYNAMIC_DRAW);

  const vertexArray = (
    into: (() => void)[],
    inputs: {
      buffer: WebGLBuffer;
      floats: number;
      attributes: Attribute[];
      perInstance?: boolean;
    }[],
    indices?: WebGLBuffer,
  ) => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    for (const input of inputs) {
      gl.bindBuffer(gl.ARRAY_BUFFER, input.buffer);
      for (const [location, size, offset] of input.attributes) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(
          location,
          size,
          gl.FLOAT,
          false,
          input.floats * 4,
          offset * 4,
        );
        if (input.perInstance) gl.vertexAttribDivisor(location, 1);
      }
    }
    if (indices) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bindVertexArray(null);
    into.push(() => gl.deleteVertexArray(vao));
    return vao;
  };

  const geometry = (
    mesh: Mesh,
    floats: number,
    attributes: Attribute[],
    into: (() => void)[],
  ): Geometry => {
    const vertices = buffer(
      gl.ARRAY_BUFFER,
      mesh.vertices,
      gl.STATIC_DRAW,
      into,
    );
    const indices =
      mesh.indices &&
      buffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW, into);
    return {
      vao: vertexArray(
        into,
        [{ buffer: vertices, floats, attributes }],
        indices,
      ),
      count: mesh.indices?.length ?? mesh.vertices.length / floats,
      indexed: Boolean(indices),
    };
  };

  const atlas = gl.createTexture();
  cleanup.push(() => gl.deleteTexture(atlas));
  gl.activeTexture(gl.TEXTURE0 + UNITS.atlas);
  gl.bindTexture(gl.TEXTURE_2D, atlas);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  for (const [level, image] of mipLevels(setup.atlas).entries())
    gl.texImage2D(
      gl.TEXTURE_2D,
      level,
      gl.RGBA8,
      image.width,
      image.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(
        image.data.buffer,
        image.data.byteOffset,
        image.data.byteLength,
      ),
    );
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const anisotropic = gl.getExtension("EXT_texture_filter_anisotropic");
  if (anisotropic)
    gl.texParameterf(gl.TEXTURE_2D, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, 4);

  const shadowSize = settings.shadowSize;
  const shadowMap = gl.createTexture();
  cleanup.push(() => gl.deleteTexture(shadowMap));
  gl.activeTexture(gl.TEXTURE0 + UNITS.shadowMap);
  gl.bindTexture(gl.TEXTURE_2D, shadowMap);
  gl.texStorage2D(
    gl.TEXTURE_2D,
    1,
    gl.DEPTH_COMPONENT24,
    shadowSize,
    shadowSize,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_COMPARE_MODE,
    gl.COMPARE_REF_TO_TEXTURE,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  const shadowTarget = gl.createFramebuffer();
  cleanup.push(() => gl.deleteFramebuffer(shadowTarget));
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowTarget);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.DEPTH_ATTACHMENT,
    gl.TEXTURE_2D,
    shadowMap,
    0,
  );
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const blocks = {
    eye: uniformBlock(CAMERA_FLOATS),
    sun: uniformBlock(CAMERA_FLOATS),
    frame: uniformBlock(FRAME_FLOATS),
    current: uniformBlock(LOOK_FLOATS),
    incoming: uniformBlock(LOOK_FLOATS),
  };
  const lookData = new Float32Array(LOOK_FLOATS);
  const drawBlock = (model: ArrayLike<number>, variant: number) => {
    const data = new Float32Array(DRAW_FLOATS);
    data.set(model);
    data[16] = variant;
    return uniformBlock(DRAW_FLOATS, data);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const plain = drawBlock(identity, 0);
  const mossDraw = drawBlock(identity, 1);

  const leafSet = (
    leaves: Float32Array<ArrayBuffer>,
    into: (() => void)[],
  ): LeafSet => {
    const count = leaves.length / LEAF_FLOATS;
    const data = buffer(gl.ARRAY_BUFFER, leaves, gl.DYNAMIC_DRAW, into);
    const gone = new Float32Array(count).fill(NEVER);
    const goneBuffer = buffer(gl.ARRAY_BUFFER, gone, gl.DYNAMIC_DRAW, into);
    const vao = vertexArray(into, [
      {
        buffer: data,
        floats: LEAF_FLOATS,
        attributes: [
          [0, 4, 0],
          [1, 4, 4],
          [2, 4, 8],
        ],
        perInstance: true,
      },
      {
        buffer: goneBuffer,
        floats: 1,
        attributes: [[3, 1, 0]],
        perInstance: true,
      },
    ]);
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    return { leaves, count, gone, order, vao, data, goneBuffer };
  };
  const uploadGone = (set: LeafSet) => {
    const sorted = new Float32Array(set.count);
    for (let i = 0; i < set.count; i++) sorted[i] = set.gone[set.order[i]];
    gl.bindBuffer(gl.ARRAY_BUFFER, set.goneBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sorted);
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
    set.order = nearestFirst(set.leaves, fromViewer(viewer));
    const sorted = new Float32Array(set.leaves.length);
    for (let i = 0; i < set.count; i++) {
      const from = set.order[i] * LEAF_FLOATS;
      sorted.set(
        set.leaves.subarray(from, from + LEAF_FLOATS),
        i * LEAF_FLOATS,
      );
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, set.data);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sorted);
    uploadGone(set);
  };

  const barkAttributes: Attribute[] = [
    [0, 3, 0],
    [1, 3, 3],
    [2, 3, 6],
    [3, 1, 9],
    [4, 2, 10],
  ];
  const solidAttributes: Attribute[] = [
    [0, 3, 0],
    [1, 3, 3],
  ];
  const moss = leafSet(setup.moss, cleanup);
  const solids = setup.solids.map((solid) => ({
    geometry: geometry(solid.mesh, SOLID_FLOATS, solidAttributes, cleanup),
    draw: drawBlock(solid.model, solid.variant),
  }));
  const fall = buffer(
    gl.ARRAY_BUFFER,
    settings.fallingLeaves * FALL_FLOATS * 4,
    gl.DYNAMIC_DRAW,
  );
  const fallVao = vertexArray(cleanup, [
    {
      buffer: fall,
      floats: FALL_FLOATS,
      attributes: [
        [0, 3, 0],
        [1, 3, 3],
        [2, 3, 6],
        [3, 4, 9],
        [4, 4, 13],
      ],
      perInstance: true,
    },
  ]);
  const empty = vertexArray(cleanup, []);

  let tree:
    | { bark: Geometry; crown: LeafSet; cleanup: (() => void)[] }
    | undefined;
  const destroyTree = () => {
    for (const release of tree?.cleanup ?? []) release();
  };

  let size = { width: 1, height: 1 };
  let incoming:
    | { target: WebGLFramebuffer; cleanup: (() => void)[] }
    | undefined;
  const destroyIncoming = () => {
    for (const release of incoming?.cleanup ?? []) release();
    incoming = undefined;
  };
  const incomingTarget = () => {
    if (incoming) return incoming.target;
    const released: (() => void)[] = [];
    const color = gl.createTexture();
    released.push(() => gl.deleteTexture(color));
    gl.activeTexture(gl.TEXTURE0 + UNITS.incoming);
    gl.bindTexture(gl.TEXTURE_2D, color);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size.width, size.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const depth = gl.createRenderbuffer();
    released.push(() => gl.deleteRenderbuffer(depth));
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(
      gl.RENDERBUFFER,
      gl.DEPTH_COMPONENT24,
      size.width,
      size.height,
    );
    const target = gl.createFramebuffer();
    released.push(() => gl.deleteFramebuffer(target));
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      color,
      0,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      depth,
    );
    incoming = { target, cleanup: released };
    return target;
  };

  const bindBlocks = (camera: WebGLBuffer, look: WebGLBuffer) => {
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BLOCKS.Camera, camera);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BLOCKS.Frame, blocks.frame);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BLOCKS.Look, look);
  };
  const useDraw = (draw: WebGLBuffer) =>
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BLOCKS.Draw, draw);
  const cull = (on: boolean) =>
    on ? gl.enable(gl.CULL_FACE) : gl.disable(gl.CULL_FACE);
  const drawGeometry = (shape: Geometry) => {
    gl.bindVertexArray(shape.vao);
    if (shape.indexed)
      gl.drawElements(gl.TRIANGLES, shape.count, gl.UNSIGNED_INT, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, shape.count);
  };
  const drawLeaves = (set: LeafSet) => {
    gl.bindVertexArray(set.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, QUAD_VERTICES, set.count);
  };

  const castShadows = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowTarget);
    gl.viewport(0, 0, shadowSize, shadowSize);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    bindBlocks(blocks.sun, blocks.current);
    useDraw(plain);
    if (tree) {
      cull(true);
      gl.useProgram(programs.barkDepth);
      drawGeometry(tree.bark);
      cull(false);
      gl.useProgram(programs.leafDepth);
      drawLeaves(tree.crown);
    }
    cull(true);
    gl.useProgram(programs.solidDepth);
    for (const solid of solids) {
      useDraw(solid.draw);
      drawGeometry(solid.geometry);
    }
  };

  const drawScene = (
    target: WebGLFramebuffer | null,
    look: WebGLBuffer,
    clear: Look["ground"],
  ) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, size.width, size.height);
    gl.depthMask(true);
    gl.clearColor(clear.x, clear.y, clear.z, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    bindBlocks(blocks.eye, look);
    useDraw(plain);
    cull(false);
    gl.useProgram(programs.ground);
    gl.bindVertexArray(empty);
    gl.drawArrays(gl.TRIANGLES, 0, QUAD_VERTICES);
    const coverage = antialias && target === null;
    if (tree) {
      cull(true);
      gl.useProgram(programs.bark);
      drawGeometry(tree.bark);
      cull(false);
      gl.useProgram(programs.leaf);
      if (coverage) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      drawLeaves(tree.crown);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    }
    cull(true);
    gl.useProgram(programs.solid);
    for (const solid of solids) {
      useDraw(solid.draw);
      drawGeometry(solid.geometry);
    }
    cull(false);
    useDraw(mossDraw);
    gl.useProgram(programs.leaf);
    if (coverage) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    drawLeaves(moss);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    useDraw(plain);
    gl.useProgram(programs.fall);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.depthMask(false);
    gl.bindVertexArray(fallVao);
    gl.drawArraysInstanced(
      gl.TRIANGLES,
      0,
      QUAD_VERTICES,
      settings.fallingLeaves,
    );
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  };

  const wipe = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, size.width, size.height);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.useProgram(programs.wipe);
    gl.bindVertexArray(empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
  };

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.cullFace(gl.BACK);

  return {
    resize(width, height) {
      size = { width, height };
      destroyIncoming();
    },

    setTree(bark, leaves) {
      destroyTree();
      const released: (() => void)[] = [];
      tree = {
        bark: geometry(bark, BARK_FLOATS, barkAttributes, released),
        crown: leafSet(leaves, released),
        cleanup: released,
      };
      shadowsDue.invalidate();
    },

    setGone(gone) {
      if (!tree) return;
      tree.crown.gone.set(gone);
      uploadGone(tree.crown);
    },

    setFalling(changed, firstLeaf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, fall);
      gl.bufferSubData(gl.ARRAY_BUFFER, firstLeaf * FALL_FLOATS * 4, changed);
    },

    render(state) {
      if (gl.isContextLost()) return;
      const upload = (block: WebGLBuffer, data: Float32Array<ArrayBuffer>) => {
        gl.bindBuffer(gl.UNIFORM_BUFFER, block);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, data);
      };
      upload(blocks.frame, state.frame);
      upload(blocks.eye, state.eye);
      upload(blocks.sun, state.sun);
      packLook(state.current, lookData, 0);
      upload(blocks.current, lookData);
      if (state.incoming) {
        packLook(state.incoming, lookData, 0);
        upload(blocks.incoming, lookData);
      }
      sortForViewer(moss, state.viewer);
      if (tree) sortForViewer(tree.crown, state.viewer);

      if (shadowsDue.due()) castShadows();
      drawScene(null, blocks.current, state.current.ground);
      if (state.incoming) {
        drawScene(incomingTarget(), blocks.incoming, state.incoming.ground);
        wipe();
      } else destroyIncoming();
    },

    dispose() {
      destroyIncoming();
      destroyTree();
      for (const release of cleanup) release();
    },
  };
}

/** Creates a garden for browsers without WebGPU. The context needs a depth buffer. */
export function createWebGLGarden(
  gl: WebGL2RenderingContext,
  options: GardenOptions,
): WebGLGarden {
  return createSimulation(options, (setup) => createWebGLRenderer(gl, setup));
}
