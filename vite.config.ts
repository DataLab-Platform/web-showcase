import { defineConfig } from "vitest/config";

// Relative base: the host page works from any folder (GitHub Pages serves it
// under ``/web-showcase/``, a local server anywhere), next to DataLab Web.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 5190,
    strictPort: true,
  },
  preview: {
    port: 5191,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts"],
  },
});
