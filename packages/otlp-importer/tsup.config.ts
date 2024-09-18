import { defineConfig } from "tsup";

export default defineConfig({
  name: "main",
  config: "tsconfig.build.json",
  entry: ["./src/index.ts"],
  outDir: "./dist",
  platform: "node",
  format: ["cjs", "esm"],
  legacyOutput: false,
  sourcemap: true,
  clean: true,
  bundle: true,
  splitting: false,
  dts: true,
  treeshake: {
    preset: "recommended",
  },
});
