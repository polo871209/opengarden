# @opengardenjs/web

Mounts an opengarden tree in a web page. It draws with WebGPU if the browser has it, and with WebGL2 if not. Set `renderer` to `webgpu` or `webgl` to force one, and read `garden.renderer` to see which one draws.

```ts
import { cherry } from "@opengardenjs/cherry";
import { mountGarden } from "@opengardenjs/web";

const garden = await mountGarden(host, { species: cherry, season: "spring" });
garden.setSeason("winter");
garden.dispose();
```

The garden fills `host`, so give `host` a size. To show the hint and the season and new tree buttons, set `controls: true`.

To match the page, set `scene` to replace scene colors in every season. `ground` is also the color behind the garden. To leave room for content on one side, set `offsetX` to move the tree by a share of the canvas width, and call `setOffsetX` when the layout changes.

```ts
const garden = await mountGarden(host, {
  species: cherry,
  scene: { ground: "#f2ecbc", gravel: "#ece5b6", rake: "#e5ddb0" },
  offsetX: 0.18,
});
garden.setOffsetX(0);
```

To match the page's own palette, set `trees` to replace the species' tree colors in some seasons. `scene` can also be a function that gives the scene colors for each season. `setColors` changes both later, for example when the page switches to a dark theme, with the same wipe as a season change.

```ts
garden.setColors({
  trees: {
    spring: {
      crown: ["#9c8aa6", "#c3a0b2", "#d9b9c2", "#ead3d6"],
      leaf: "blossom",
      bark: "#a49aa4",
      barkShade: "#757186",
    },
  },
  scene: {
    ground: "#24273a",
    gravel: "#212436",
    rake: "#30344a",
    shadow: "#15161f",
    snow: "#a9b0cc",
  },
});
```

## Run it on a slow device

On a weak GPU, such as a phone or a photo frame, lower the resolution, the frame rate and the `quality` settings. A photo frame with a Mali-G31 GPU and Android WebView 106, which has no WebGPU, uses these settings:

```ts
const garden = await mountGarden(host, {
  species: cherry,
  renderScale: 0.6,
  maxFps: 30,
  quality: {
    leafDensity: 0.5,
    antialias: false,
    shadowSize: 512,
    shadowInterval: 2,
    shadowSamples: 4,
    leafShadowSamples: 1,
    fallingLeaves: 2000,
  },
});
```

- `renderScale` draws the canvas at this share of the screen resolution, and the browser scales it up.
- `leafDensity` grows this share of the leaves. Each leaf grows a little larger, so the crown still looks full.
- `shadowSize`, `shadowInterval`, `shadowSamples` and `leafShadowSamples` set the size of the shadow map, how often it updates, and how many samples each pixel of ground and of leaf reads from it.
- `fallingLeaves` caps the leaves that fall at once.
