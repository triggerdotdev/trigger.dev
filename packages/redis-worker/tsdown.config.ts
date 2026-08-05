import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  fixedExtension: false,
  tsconfig: "tsconfig.src.json",
  dts: {
    sourcemap: false,
  },
  sourcemap: true,
  // The CJS declarations are emitted in a separate pass, so their output can
  // disable source maps without affecting the runtime bundle.
  outputOptions(options, _format, { cjsDts }) {
    if (!cjsDts) return;

    return {
      ...options,
      sourcemap: false,
    };
  },
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
    // The ESM declarations share an output pass with the runtime bundle.
    // Remove their dangling map comment while retaining runtime source maps.
    {
      name: "strip-declaration-sourcemap-comments",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk" || !/\.d\.(?:c|m)?ts$/.test(output.fileName)) {
            continue;
          }

          output.code = output.code.replace(/\n?\/\/# sourceMappingURL=.*$/m, "");
        }
      },
    },
    {
      name: "resilient-create-require",
      renderChunk(code: string) {
        const unsafeCreateRequire = /(\b[\w$]*createRequire[\w$]*\s*\()\s*import\.meta\.url\s*\)/g;
        const patched = code.replace(
          unsafeCreateRequire,
          "$1import.meta.url || process.cwd() + '/index.js')"
        );

        if (patched === code) return null;

        return {
          code: patched,
          map: null,
        };
      },
      generateBundle(_options, bundle) {
        const unsafeCreateRequire = /\b[\w$]*createRequire[\w$]*\s*\(\s*import\.meta\.url\s*\)/;

        for (const output of Object.values(bundle)) {
          if (output.type === "chunk" && unsafeCreateRequire.test(output.code)) {
            throw new Error(`Unsafe createRequire helper remained in ${output.fileName}`);
          }
        }
      },
    },
  ],
});
