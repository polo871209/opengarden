# opengarden

A procedural tree garden, published as a pnpm monorepo of small libraries. `@opengardenjs/core` draws it with WebGPU in the browser through `navigator.gpu` and in the terminal through Dawn (the `webgpu` package) and the Kitty graphics protocol. Browsers without WebGPU get the WebGL2 renderer. The published packages have no runtime dependencies. `math.ts` in core holds the vector and camera math, so do not add three.js or another math library back.

## Set up

1. Run `mise install`, then `pnpm install`. Node runs the `.ts` files directly.
2. Install Google Chrome. Playwright drives it (`channel: "chrome"`) for `apps/playground/scripts` and `tools/bench`.
3. To run `pnpm term`, use a terminal that supports Kitty animation edits (`a=f`), such as Rex or Kitty.

## Put code in its layer

`pnpm lint` enforces these layers with Biome (`biome.json`) and `tools/layout` (rules in `tools/layout/src/default.ts`):

- `packages/core`: simulation, meshes and renderer. Code here runs in browsers and in Node, so it uses no DOM globals and no `node:` modules.
- `packages/web`: the DOM host. `packages/terminal`: the Node and Kitty host. `packages/cli`: argument parsing only.
- `trees/<name>`: one `Species` per package, with `@opengardenjs/core` as its only peer and no dependencies.
- `apps` and `tools`: private packages.

Packages import each other by package name. The `@opengardenjs/source` export condition maps each name to its `src`, so development needs no build step.

## Rules the code cannot show

- Keep the Dawn `webgpu` object and the adapter referenced for the whole process. If either is garbage collected while the device lives, dawn.node segfaults.
- The WebGL2 renderer (`webgl.ts`) runs a GLSL ES 3.00 port of the WGSL in `wgsl.ts`, kept in `glsl.ts`. When you change a shader in `wgsl.ts`, make the same change in `glsl.ts`. The garden must look the same in both. Both read their uniform layout from `uniforms.ts`, and only `webgpu.ts` imports `wgsl.ts`, so a WebGL2 page never downloads the WGSL.
- Send Kitty image data as files (`t=f`). Rex mis-parses inline base64 and deletes shared memory after one read.

## Make sure that a change works

1. Run `pnpm check`. It lints, type-checks and builds every package.
2. If you changed `packages/terminal/src/capture.ts` or `kitty.ts`, run `pnpm bench --only terminal --runs 1`. It first fails if the terminal image differs from the render.
3. If you changed how the page looks, start `pnpm dev`, run `pnpm --filter @opengardenjs/playground shot`, and look at `apps/playground/shots/mine.png`. Run it again with the URL `http://localhost:5173/?renderer=webgl` and an output path, and make sure that the WebGL2 image matches.
4. If you claim a speed gain, run `pnpm bench --baseline baseline.json`. Only a metric marked `better` is a real gain. After the gain lands, save a new baseline with `--save baseline.json`. On a machine other than the one in the baseline, save your own baseline before you change anything.
