import { defineConfig } from "tsup";

export default defineConfig([
  {
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
    noExternal: ["@trigger.dev/common-schemas"],
    external: ["http", "https", "util", "events", "tty", "os", "timers"],
  },
  {
    name: "internal",
    entry: ["./src/internal.ts"],
    outDir: "./dist",
    platform: "node",
    format: ["cjs"],
    legacyOutput: true,
    sourcemap: true,
    clean: true,
    bundle: true,
    splitting: false,
    dts: true,
    esbuildPlugins: [],
    noExternal: ["@trigger.dev/common-schemas"],
    external: ["http", "https", "util", "events", "tty", "os", "timers"],
  },
]);
