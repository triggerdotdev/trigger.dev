import { defineConfig } from "tsup";

const isDev = process.env.npm_lifecycle_event === "dev";
//command to copy the "templates" folder to dist/templates
const copyTemplates = "cp -r src/templates dist";

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
  onSuccess: isDev ? `${copyTemplates} && node dist/index.js` : copyTemplates,
});
