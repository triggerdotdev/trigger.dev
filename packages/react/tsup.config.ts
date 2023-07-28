import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/*.ts", "src/*.tsx"],
    format: ["cjs", "esm"],
    target: ["es2020", "node16"],
    outDir: "dist",
    dts: true,
    sourcemap: true,
    clean: true,
    bundle: false,
    outExtension({ format }) {
      return {
        js: `.${format === "esm" ? "js" : "cjs"}`,
      };
    },
  },
]);
