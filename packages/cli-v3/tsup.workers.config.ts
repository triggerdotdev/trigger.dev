import { defineConfig } from "tsup";

export default defineConfig({
  clean: false,
  dts: false,
  tsconfig: "tsconfig.json",
  splitting: false,
  entry: [
    "src/workers/dev/worker-setup.ts",
    "src/workers/dev/worker-facade.ts",
    "src/workers/prod/worker-setup.ts",
    "src/workers/prod/worker-facade.ts",
    "src/workers/prod/entry-point.ts",
  ],
  format: ["esm"],
  minify: false,
  metafile: false,
  sourcemap: false,
  target: "esnext",
  outDir: "dist/workers",
  noExternal: ["@trigger.dev/core-apps"],
});
