# @opengardenjs/terminal

Runs an opengarden tree full screen in a terminal. It renders with Dawn through the `webgpu` package and sends frames with the Kitty graphics protocol. The terminal must support Kitty graphics animation (`a=f`), for example Kitty or Rex.

```ts
import { cherry } from "@opengardenjs/cherry";
import { runInTerminal } from "@opengardenjs/terminal";

await runInTerminal({ species: cherry, season: "autumn" });
```

`runInTerminal` resolves when the user presses `q` and the terminal is restored. For your own frame loop, use `createCapturer` and `createKittyScreen`.
