import type { Garden } from "@opengardenjs/core";

/** Square of pixels that the GPU compares between frames. */
export const BLOCK = 16;
const PIXELS_PER_THREAD = 4;
const GROUP = 256;
const MAX_GROUPS = 65535;
const SLOTS = 2;

const shader = /* wgsl */ `
struct Params { width: u32, pixels: u32, columns: u32 }

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var current: texture_2d<f32>;
@group(0) @binding(2) var previous: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> dirty: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> rgb: array<u32>;

@compute @workgroup_size(${GROUP})
fn pack(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let quad = id.x + id.y * groups.x * ${GROUP}u;
  let first = quad * ${PIXELS_PER_THREAD}u;
  if (first >= params.pixels) { return; }
  var texels: array<vec3f, ${PIXELS_PER_THREAD}>;
  for (var i = 0u; i < ${PIXELS_PER_THREAD}u; i++) {
    let index = first + i;
    if (index < params.pixels) {
      let pixel = vec2u(index % params.width, index / params.width);
      texels[i] = textureLoad(current, pixel, 0).rgb;
      if (any(texels[i] != textureLoad(previous, pixel, 0).rgb)) {
        atomicStore(&dirty[pixel.y / ${BLOCK}u * params.columns + pixel.x / ${BLOCK}u], 1u);
      }
    }
  }
  rgb[quad * 3u] = pack4x8unorm(vec4f(texels[0], texels[1].r));
  rgb[quad * 3u + 1u] = pack4x8unorm(vec4f(texels[1].gb, texels[2].rg));
  rgb[quad * 3u + 2u] = pack4x8unorm(vec4f(texels[2].b, texels[3]));
}
`;

/** One frame in mapped GPU memory. The views are valid until {@link release}. */
export interface Capture {
  width: number;
  height: number;
  /** Blocks across. Block `(x, y)` is `dirty[y * columns + x]`. */
  columns: number;
  rows: number;
  /** Non-zero for each {@link BLOCK} square that changed since the previous capture. */
  dirty: Uint32Array;
  /** Tightly packed RGB, rows top first. */
  rgb: Uint8Array;
  release(): void;
}

export interface Capturer {
  /** Sizes the render targets and drops frames that were not read. The caller resizes the garden. */
  resize(width: number, height: number): void;
  /**
   * Renders the garden and starts to read it back. Two frames can wait to be
   * read, and the GPU works on them while the caller does other work.
   */
  render(): void;
  /** Resolves with the oldest rendered frame that was not read. */
  read(): Promise<Capture>;
}

interface Target {
  texture: GPUTexture;
  view: GPUTextureView;
}

interface Sized {
  width: number;
  height: number;
  columns: number;
  rows: number;
  targets: [Target, Target];
  groups: [GPUBindGroup, GPUBindGroup];
  params: GPUBuffer;
  dirty: GPUBuffer;
  rgb: GPUBuffer;
  readbacks: GPUBuffer[];
  dirtyBytes: number;
  rgbBytes: number;
  packGroups: [number, number];
}

/**
 * Renders into two textures in turn, so each frame can be compared with the
 * one before. A compute pass marks the blocks that changed and packs the frame
 * as RGB, and the CPU reads both from mapped memory.
 */
export function createCapturer(
  device: GPUDevice,
  garden: Garden,
  format: GPUTextureFormat,
): Capturer {
  const module = device.createShaderModule({ code: shader });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: {} },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: {} },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
    ],
  });
  const pack = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: "pack" },
  });

  let sized: Sized | undefined;
  let frame = 0;
  const unread: GPUBuffer[] = [];

  const target = (width: number, height: number): Target => {
    const texture = device.createTexture({
      size: [width, height],
      format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    return { texture, view: texture.createView() };
  };

  return {
    resize(width, height) {
      if (sized) {
        for (const target of sized.targets) target.texture.destroy();
        for (const buffer of [
          sized.params,
          sized.dirty,
          sized.rgb,
          ...sized.readbacks,
        ])
          buffer.destroy();
      }
      unread.length = 0;
      const columns = Math.ceil(width / BLOCK);
      const rows = Math.ceil(height / BLOCK);
      const dirtyBytes = columns * rows * 4;
      const threads = Math.ceil((width * height) / PIXELS_PER_THREAD);
      const rgbBytes = threads * PIXELS_PER_THREAD * 3;
      const groups = Math.ceil(threads / GROUP);
      const packGroups: [number, number] = [
        Math.min(groups, MAX_GROUPS),
        Math.ceil(groups / MAX_GROUPS),
      ];
      const params = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(
        params,
        0,
        new Uint32Array([width, width * height, columns, 0]),
      );
      const storage = (size: number) =>
        device.createBuffer({
          size,
          usage:
            GPUBufferUsage.STORAGE |
            GPUBufferUsage.COPY_SRC |
            GPUBufferUsage.COPY_DST,
        });
      const dirty = storage(dirtyBytes);
      const rgb = storage(rgbBytes);
      const targets: [Target, Target] = [
        target(width, height),
        target(width, height),
      ];
      const group = (current: Target, previous: Target) =>
        device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: params } },
            { binding: 1, resource: current.view },
            { binding: 2, resource: previous.view },
            { binding: 3, resource: { buffer: dirty } },
            { binding: 4, resource: { buffer: rgb } },
          ],
        });
      sized = {
        width,
        height,
        columns,
        rows,
        targets,
        groups: [group(targets[0], targets[1]), group(targets[1], targets[0])],
        params,
        dirty,
        rgb,
        readbacks: Array.from({ length: SLOTS }, () =>
          device.createBuffer({
            size: dirtyBytes + rgbBytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          }),
        ),
        dirtyBytes,
        rgbBytes,
        packGroups,
      };
    },

    render() {
      if (!sized) throw new Error("render() needs resize() first");
      if (unread.length === SLOTS)
        throw new Error(`render() needs read() first: ${SLOTS} frames wait`);
      const s = sized;
      const index = frame % 2;
      const readback = s.readbacks[frame % SLOTS];
      frame++;
      const encoder = device.createCommandEncoder();
      garden.render(s.targets[index].view, encoder);
      encoder.clearBuffer(s.dirty);
      const pass = encoder.beginComputePass();
      pass.setBindGroup(0, s.groups[index]);
      pass.setPipeline(pack);
      pass.dispatchWorkgroups(...s.packGroups);
      pass.end();
      encoder.copyBufferToBuffer(s.dirty, 0, readback, 0, s.dirtyBytes);
      encoder.copyBufferToBuffer(s.rgb, 0, readback, s.dirtyBytes, s.rgbBytes);
      device.queue.submit([encoder.finish()]);
      unread.push(readback);
    },

    async read() {
      const readback = unread.shift();
      if (!sized || !readback) throw new Error("read() needs render() first");
      const s = sized;
      await readback.mapAsync(GPUMapMode.READ);
      const mapped = readback.getMappedRange();
      return {
        width: s.width,
        height: s.height,
        columns: s.columns,
        rows: s.rows,
        dirty: new Uint32Array(mapped, 0, s.columns * s.rows),
        rgb: new Uint8Array(mapped, s.dirtyBytes, s.width * s.height * 3),
        release: () => readback.unmap(),
      };
    },
  };
}
