import { vitePlugin as remix } from "@remix-run/dev";
import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      // .mjs so the CJS server.ts wrapper can dynamic-import it
      serverBuildFile: "index.mjs",
    }),
    tsconfigPaths(),
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
      "@fingerprintjs/fingerprintjs-pro-react",
      "@kapaai/react-sdk",
      "@fingerprintjs/fingerprintjs-pro",
      "@fingerprintjs/fingerprintjs-pro-spa",
    ],
    optimizeDeps: {
      include: ["cron-parser"],
    },
  },
});
