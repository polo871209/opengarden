# @opengardenjs/core

The opengarden simulation and its WebGPU renderer. It has no DOM and no Node code, so a host passes in a GPU device and a painted leaf atlas. Most apps use [`@opengardenjs/web`](https://github.com/polo871209/opengarden/tree/main/packages/web) or [`@opengardenjs/terminal`](https://github.com/polo871209/opengarden/tree/main/packages/terminal) instead of this package.

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

A tree package exports a `Species`. Its `grow` function adds branches and leaves with a `TreeBuilder`, and its `looks` give the colors for each season. See [`@opengardenjs/cherry`](https://github.com/polo871209/opengarden/tree/main/trees/cherry) for an example.
