import { defineConfig } from "tsup";

export default defineConfig([
  {
    target: "es2018",
    external: ["react"],
    sourcemap: true,
    dts: true,
    format: ["esm", "cjs"],
    esbuildOptions(options) {
      options.banner = {
        js: '"use client";\n',
      };
      options.jsx = "automatic";
    },
  },
]);
