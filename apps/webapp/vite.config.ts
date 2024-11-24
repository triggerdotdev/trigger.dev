import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { vitePlugin as remix } from "@remix-run/dev";
import { cjsInterop } from "vite-plugin-cjs-interop";
import { installGlobals } from "@remix-run/node";
import { config } from "dotenv";
import { expand } from "dotenv-expand";

// TODO: can be replaced with infisical?
expand(
  config({
    path: "../../.env",
  })
);

installGlobals({ nativeFetch: true });

export default defineConfig(({ isSsrBuild }) => ({
  build: {
    target: "ES2022",
    sourcemap: true,
    minify: false,
    rollupOptions: isSsrBuild
      ? // This includes ./server/app.ts in the Vite build process
        // Any server integrations that need app code should go there
        // then server.js can import it as middleware
        { input: ["./server/app.ts"] }
      : undefined,
  },

  resolve: {
    alias: [
      // [commonjs--resolver] Failed to resolve entry for package "https"
      // Vite attempts to resolve this through npm instead of the node native package
      // Prefer importing node:https but this will fix dependencies who do it wrong
      { find: "https", replacement: "node:https" },
      { find: "path", replacement: "node:path" },
      { find: "os", replacement: "node:os" },
      { find: "crypto", replacement: "node:crypto" },
      { find: "stream", replacement: "node:stream" },
      { find: "console", replacement: "node:console" },
      { find: "assert", replacement: "node:assert" },
      { find: "buffer", replacement: "node:buffer" },
    ],
  },

  plugins: [
    cjsInterop({
      dependencies: [
        // The requested module 'cron-parser' is a CommonJS module, which may not support all module.exports as named exports.
        // CommonJS modules can always be imported via the default export, for example using:
        // import pkg from 'cron-parser';
        // const {parseExpression} = pkg;
        "@prisma/instrumentation",
        "cron-parser",
        "react-use",
        "regression",
        // import * as TooltipPrimitive from "@radix-ui/react-tooltip"
        // Tooltip.displayName = …
        // TypeError: Cannot read properties of undefined (reading 'displayName')
        "@radix-ui/react-tooltip",
        "@radix-ui/react-popover",
        "@radix-ui/react-dialog",
        "@radix-ui/react-label",
        "@radix-ui/react-select",
        "@radix-ui/react-tabs",
      ],
    }),
    !process.env.VITEST &&
      remix({
        future: {
          unstable_optimizeDeps: true,
        },
        ignoredRouteFiles: ["**/.*", "**/*.server.ts", "**/*.client.ts"],
      }),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
  ],
}));
