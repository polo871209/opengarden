# @opengardenjs/web

Mounts an opengarden tree in a web page. The browser must support WebGPU.

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
