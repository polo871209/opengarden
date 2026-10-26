# @opengardenjs/core

The opengarden simulation and its WebGPU and WebGL2 renderers. It has no DOM, no Node code and no dependencies, so a host passes in a GPU device or a WebGL2 context, and a painted leaf atlas. Most apps use [`@opengardenjs/web`](https://github.com/polo871209/opengarden/tree/main/packages/web) or [`@opengardenjs/terminal`](https://github.com/polo871209/opengarden/tree/main/packages/terminal) instead of this package.

```ts
import { cherry } from "@opengardenjs/cherry";
import {
  ATLAS_HEIGHT,
  ATLAS_WIDTH,
  createGarden,
  paintLeafAtlas,
} from "@opengardenjs/core";

const ctx = new OffscreenCanvas(ATLAS_WIDTH, ATLAS_HEIGHT).getContext("2d")!;
paintLeafAtlas(ctx);
const garden = createGarden(device, format, {
  species: cherry,
  atlas: ctx.getImageData(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT),
});
garden.resize(width, height, devicePixelRatio);
garden.update(1 / 60);
garden.render(context.getCurrentTexture().createView());
```

Where the browser has no WebGPU, pass a WebGL2 context with a depth buffer to `createWebGLGarden` instead. It takes the same options, and its `render()` draws into the context's canvas.

```ts
const gl = canvas.getContext("webgl2", { alpha: false, depth: true })!;
const garden = createWebGLGarden(gl, { species: cherry, atlas });
garden.render();
```

The package root exports both renderers. To ship only one renderer, import its factory from `@opengardenjs/core/webgpu` or `@opengardenjs/core/webgl` instead. `@opengardenjs/web` does this with `import()`, so a page downloads only the renderer that draws.

A tree package exports a `Species`. Its `grow` function adds branches and leaves with a `TreeBuilder`, and its `looks` give the colors for each season. See [`@opengardenjs/cherry`](https://github.com/polo871209/opengarden/tree/main/trees/cherry) for an example.
