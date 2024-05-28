import { defineConfig } from "tsup";

export default defineConfig({
  clean: false,
  dts: false,
  tsconfig: "tsconfig.json",
  splitting: false,
  entry: { e2e: "e2e/index.ts" },
  format: ["esm"],
  minify: false,
  metafile: false,
  sourcemap: true,
  target: "esnext",
  outDir: "dist",
  banner: {
    js: "import { createRequire as createRequireFromMetaUrl } from 'node:module';const require = createRequireFromMetaUrl(import.meta.url);",
  },
});
