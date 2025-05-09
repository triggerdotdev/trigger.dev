import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  bundle: true,
  minify: false,
  noExternal: [
    // Always bundle internal packages
    /^@internal/,
    // Always bundle ESM-only packages
    "nanoid",
    "p-limit",
  ],
  banner: ({ format }) => {
    if (format !== "esm") return;

    return {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url || process.cwd() + '/index.js');`,
    };
  },
});
