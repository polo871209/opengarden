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
