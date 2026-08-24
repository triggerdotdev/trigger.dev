import { readFileSync } from "node:fs";
import { vitePlugin as remix } from "@remix-run/dev";
import { defaultClientConditions, defaultServerConditions, defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const packageVersions: Record<string, string> = Object.fromEntries(
  ["core", "trigger-sdk"].map((pkg) => [
    pkg,
    (
      JSON.parse(
        readFileSync(new URL(`../../packages/${pkg}/package.json`, import.meta.url), "utf-8")
      ) as { version: string }
    ).version,
  ])
);

/**
 * The `@triggerdotdev/source` condition resolves workspace packages to TS source, where
 * each VERSION constant is the "0.0.0" placeholder (scripts/updateVersion.ts stamps the
 * real version, but only in dist output, which this bundle never reads). Stamp the version
 * modules during bundling so VERSION carries the real package version everywhere it's used.
 */
function stampPackageVersions(): Plugin {
  return {
    name: "stamp-package-versions",
    transform(code, id) {
      const match = id
        .split("?")[0]
        .match(/packages[/\\](core|trigger-sdk)[/\\]src[/\\]version\.ts$/);
      if (match) {
        return {
          code: code.replace('"0.0.0"', JSON.stringify(packageVersions[match[1]])),
          map: null,
        };
      }
    },
  };
}

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      // .mjs so the CJS server.ts wrapper can dynamic-import it
      serverBuildFile: "index.mjs",
    }),
    tsconfigPaths(),
    stampPackageVersions(),
  ],
  resolve: {
    // Resolve workspace packages to TS source (same condition the CLI uses)
    conditions: ["@triggerdotdev/source", ...defaultClientConditions],
    // Browser polyfills for node builtins used by client deps (antlr4ts)
    alias: [
      { find: /^assert$/, replacement: "assert/" },
      { find: /^util$/, replacement: "util/" },
    ],
  },
  optimizeDeps: {
    // Crawl all routes up front - mid-session re-optimization duplicates React
    entries: ["./app/entry.client.tsx", "./app/root.tsx", "./app/routes/**/*.{ts,tsx}"],
    esbuildOptions: {
      // node globals for prebundled CJS deps (client-only by construction)
      define: { global: "globalThis" },
      inject: ["./vite/node-globals-shim.js"],
    },
  },
  server: {
    cors: false,
    watch: {
      // Seeder scripts are not app code; running them must not full-reload the dashboard.
      ignored: ["**/seed-*.mts"],
    },
    warmup: {
      clientFiles: ["./app/entry.client.tsx", "./app/root.tsx", "./app/components/**/*.tsx"],
      ssrFiles: ["./app/entry.server.tsx", "./app/root.tsx"],
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      // Prisma wrappers and pg have CJS/native pieces Rollup can't inline
      external: [/^@trigger\.dev\/database$/, /^@internal\/run-ops-database$/, /^pg$/],
    },
  },
  ssr: {
    resolve: {
      conditions: ["@triggerdotdev/source", ...defaultServerConditions],
      externalConditions: ["@triggerdotdev/source", "node"],
    },
    // CJS Prisma clients and native pg must load through node
    external: ["@trigger.dev/database", "@internal/run-ops-database", "pg"],
    // CJS deps whose named exports node's ESM interop can't detect
    noExternal: [
      /^@radix-ui\//,
      "react-use",
      "cron-parser",
      "@kapaai/react-sdk",
      "@fingerprintjs/fingerprintjs-pro-react",
      "@fingerprintjs/fingerprintjs-pro",
      "@fingerprintjs/fingerprintjs-pro-spa",
      "recharts",
      /^victory-vendor/,
    ],
    optimizeDeps: {
      include: ["cron-parser"],
    },
  },
});
