import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    target: "es2018",
    external: ["react"],
    sourcemap: true,
    dts: true,
    bundle: true,
    format: ["esm", "cjs"],
    noExternal: ["@trigger.dev/core"],
    esbuildOptions(options) {
      options.banner = {
        js: '"use client";',
      };
    },
  },
]);
