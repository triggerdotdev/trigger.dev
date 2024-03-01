import { defineConfig } from "tsup";

export default defineConfig({
  clean: false,
  dts: false,
  tsconfig: "tsconfig.json",
  splitting: false,
  entry: ["src/worker-facade.ts"],
  format: ["esm"],
  minify: false,
  metafile: false,
  sourcemap: false,
  target: "esnext",
  outDir: "dist",
});
