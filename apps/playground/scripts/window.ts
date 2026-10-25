import type { MountedGarden } from "@opengardenjs/web";

declare global {
  interface Window {
    garden: MountedGarden;
  }
}
