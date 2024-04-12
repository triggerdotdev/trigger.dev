import { cp } from "fs/promises";
import { join } from "path";
import { defineConfig } from "tsup";

const isDev = process.env.npm_lifecycle_event === "dev:main"; // This must match the npm script name

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
  async onSuccess() {
    if (isDev) {
      console.debug("Running onSuccess() in dev");
      // exec: node dist/index.js
    }

    await cp(join("src", "templates"), "dist/templates", { recursive: true });
  },
  banner: {
    js: "import { createRequire as createRequireFromMetaUrl } from 'node:module';const require = createRequireFromMetaUrl(import.meta.url);",
  },
});
