import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  fixedExtension: false,
  tsconfig: "tsconfig.src.json",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  deps: {
    onlyBundle: false,
    alwaysBundle: [
      // Always bundle internal packages
      /^@internal/,
      // Always bundle ESM-only packages
      "nanoid",
      "p-limit",
    ],
    dts: {
      // The TypeScript 7 declaration emitter consumes referenced package declarations.
      neverBundle: [/^@internal/],
    },
  },
  banner: ({ format }) => {
    if (format !== "esm") return;

    return {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url || process.cwd() + '/index.js');`,
    };
  },
});
