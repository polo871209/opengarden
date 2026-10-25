import { defineConfig } from "astro/config";
import { defaultClientConditions } from "vite";

export default defineConfig({
  site: "https://polo871209.github.io",
  base: "/opengarden",
  compressHTML: false,
  vite: {
    resolve: {
      conditions: ["@opengardenjs/source", ...defaultClientConditions],
    },
  },
});
