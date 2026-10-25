import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  resolve: {
    conditions: ["@opengardenjs/source", ...defaultClientConditions],
  },
});
