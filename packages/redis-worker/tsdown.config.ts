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
  // rolldown injects its own `__require` helper in the ESM output as
  // `createRequire(import.meta.url)` with no fallback. When this ESM bundle is
  // re-bundled into a CJS consumer (e.g. the webapp server), esbuild replaces
  // `import.meta.url` with `undefined`, so `createRequire(undefined)` throws at
  // startup. Patch the helper to fall back to a valid path, matching the
  // fallback the previous tsup banner provided.
  plugins: [
    {
      name: "resilient-create-require",
      renderChunk(code: string) {
        if (!code.includes("createRequire(import.meta.url)")) return null;
        return {
          code: code.replaceAll(
            "createRequire(import.meta.url)",
            "createRequire(import.meta.url || process.cwd() + '/index.js')"
          ),
          map: null,
        };
      },
    },
  ],
});
