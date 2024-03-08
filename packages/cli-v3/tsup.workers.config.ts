import { defineConfig } from "tsup";

export default defineConfig({
  clean: false,
  dts: false,
  tsconfig: "tsconfig.json",
  splitting: false,
  entry: [
    "src/workers/dev/worker-facade.ts",
    "src/workers/common/register-tracing.ts",
    "src/workers/prod/worker-facade.ts",
    "src/workers/prod/entry-point.ts",
  ],
  format: ["esm"],
  minify: false,
  metafile: false,
  sourcemap: false,
  target: "esnext",
  outDir: "dist/workers",
});
