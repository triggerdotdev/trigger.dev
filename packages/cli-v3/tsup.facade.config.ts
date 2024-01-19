import { defineConfig } from "tsup";

export default defineConfig({
  clean: false,
  dts: true,
  splitting: false,
  entry: ["src/worker-facade.ts"],
  format: ["esm"],
  minify: false,
  metafile: false,
  sourcemap: true,
  target: "esnext",
  outDir: "dist",
  noExternal: ["zod"],
});
