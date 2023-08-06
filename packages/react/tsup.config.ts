import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/*.ts", "src/*.tsx"],
    format: ["cjs", "esm"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    bundle: false,
    splitting: false,
    dts: true,
    outExtension({ format }) {
      return {
        js: `.${format === "esm" ? "js" : "cjs"}`,
      };
    },
  },
]);
