import { defineConfig } from "tsup";

const isDev = process.env.npm_lifecycle_event === "dev";

export default defineConfig({
  clean: false,
  tsconfig: "tsconfig.json",
  dts: true,
  splitting: false,
  entry: ["src/index.ts"],
  format: ["esm"],
  minify: false,
  metafile: false,
  sourcemap: true,
  target: "esnext",
  outDir: "dist",
  onSuccess: isDev ? `node dist/index.js` : "",
  banner: {
    js: "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
  },
});
