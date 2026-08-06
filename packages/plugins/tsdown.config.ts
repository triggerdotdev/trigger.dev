import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
