import { defineConfig } from "tsup";

export default defineConfig({
  clean: false,
  dts: true,
  tsconfig: "tsconfig.json",
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
