import { defineConfig } from "tsup";
import { polyfillNode } from "esbuild-plugin-polyfill-node";

export default defineConfig([
  {
    name: "main",
    config: "tsconfig.build.json",
    entry: ["./src/index.ts"],
    outDir: "./dist",
    platform: "node",
    format: ["cjs", "esm"],
    legacyOutput: true,
    sourcemap: true,
    clean: true,
    bundle: true,
    splitting: false,
    dts: true,
    external: ["http", "https", "util", "events", "tty", "os", "timers" ],
    esbuildPlugins: [polyfillNode({
			globals: {
        global: false,
        buffer: true,
        process: false,
        navigator: false
      },
      polyfills: {
        buffer: true,
      },
		}) as any],
  },
]);
