import { defineConfig } from "tsup";

const isDev = process.env.npm_lifecycle_event === "dev";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts"],
  format: ["esm"],
  minify: !isDev,
  metafile: !isDev,
  sourcemap: true,
  target: "esnext",
  outDir: "dist",
  onSuccess: isDev ? `node dist/index.js` : "",
  //this is required because "xdg-app-paths" uses a dynamic import
  banner: {
    js: "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
  },
});
