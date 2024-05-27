import { defineConfig } from "tsup";

export default defineConfig({
  clean: false,
  dts: false,
  tsconfig: "tsconfig.json",
  splitting: false,
  entry: ["test/compile.ts"],
  format: ["esm"],
  minify: false,
  metafile: false,
  sourcemap: true,
  target: "esnext",
  outDir: "dist/test",
  banner: {
    js: "import { createRequire as createRequireFromMetaUrl } from 'node:module';const require = createRequireFromMetaUrl(import.meta.url);",
  },
});
