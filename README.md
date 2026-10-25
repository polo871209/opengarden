# opengarden

A small procedural garden with one tree, drawn with WebGPU. Move through the leaves and they fall, click to drop many, and switch between four seasons. The same renderer runs in a web page and in a terminal that supports the Kitty graphics protocol.

## Run it in a terminal

```sh
npx opengarden
```

Keys `1` to `4` change the season, `n` grows a new tree, and `q` quits. The terminal must support Kitty graphics animation, for example Kitty or Rex. Run `npx opengarden --help` for the options.

## Put it in a web page

```sh
npm install @opengardenjs/web @opengardenjs/cherry
```

```ts
import { cherry } from "@opengardenjs/cherry";
import { mountGarden } from "@opengardenjs/web";

const garden = await mountGarden(document.getElementById("stage")!, {
  species: cherry,
  season: "autumn",
});
```

The browser must support WebGPU. The garden fills the host element, so give the host a size.

## Packages

Each tree is its own package, so an app installs only the trees it shows.

| Package                                       | Use                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| [`@opengardenjs/core`](packages/core)         | The simulation and the WebGPU renderer. It has no DOM and no Node code. |
| [`@opengardenjs/web`](packages/web)           | Mounts a garden in a web page.                                          |
| [`@opengardenjs/terminal`](packages/terminal) | Runs a garden in a terminal through Dawn and Kitty graphics.            |
| [`opengarden`](packages/cli)                  | The `opengarden` command.                                               |
| [`@opengardenjs/cherry`](trees/cherry)        | The cherry tree.                                                        |

## Add a tree

A tree is a `Species` from `@opengardenjs/core`. It grows its branches and leaves with a `TreeBuilder`, and gives a color set for each season. Copy `trees/cherry` to `trees/<name>`, rename the package to `@opengardenjs/<name>`, and change `grow` and `looks`. `pnpm lint` fails if the new package is in the wrong place or depends on more than `@opengardenjs/core` and `three`.

## Develop

1. Install [mise](https://mise.jdx.dev), then run `mise install` and `pnpm install`.
2. Run `pnpm dev` for the web playground, or `pnpm term` for the terminal.
3. Before you push, run `pnpm check`. It lints, type-checks and builds every package.

The repository layout:

```
packages/   published libraries and the CLI
trees/      one published package per tree
apps/       private apps, such as the web playground
tools/      private tools: the benchmarks and the layout check
```

## License

[MIT](LICENSE)
