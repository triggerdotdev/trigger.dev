import { defineConfig } from "tsup";

export default defineConfig([
  {
    name: "main",
    entry: ["./src/index.ts"],
    outDir: "./dist",
    platform: "node",
    target: "node16",
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
    external: ["http", "https", "util", "events", "tty", "os", "timers"],
    esbuildPlugins: [],
  },
]);
