import { Options, defineConfig } from "tsup";

export const options: Options = {
  name: "main",
  entry: ["./src/index.ts"],
  outDir: "./dist",
  platform: "node",
  format: ["cjs"],
  legacyOutput: true,
  sourcemap: true,
  clean: true,
  bundle: true,
  splitting: false,
  dts: true,
  treeshake: {
    preset: "smallest",
  },
  esbuildPlugins: [],
  external: ["http", "https", "util", "events", "tty", "os", "timers"],
};

export default defineConfig(options);
