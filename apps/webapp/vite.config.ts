import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { expressDevServer } from "remix-express-dev-server";
import { installGlobals } from "@remix-run/node";
import { config } from "dotenv";
import { expand } from "dotenv-expand";
import { denyImports } from "vite-env-only";
import { viteCommonjs } from "@originjs/vite-plugin-commonjs";

expand(
  config({
    path: "../../.env",
  })
);

installGlobals({ nativeFetch: true });

const MODE = process.env.NODE_ENV;

export default defineConfig({
  ssr: {
    noExternal: [
      // Fixes Error when evaluating SSR module
      "react-use",
    ],
  },
  optimizeDeps: {
    entries: ["./app/entry.client.tsx", "./app/root.tsx", "./app/routes/**/*"],
    include: [
      // Has cookie and set-cookie-parser deps that need to be optimized
      "@remix-run/server-runtime",
    ],
    // Exclude if dep is ESM or runs server-side (just speeds up Vite on navigations)
    exclude: [
      // Include @prisma/client until @trigger-dev/database is ESM
      // https://github.com/prisma/prisma/issues/21474
      "@prisma/client",
      "@opentelemetry/api-logs",
      "@opentelemetry/api",
      "@opentelemetry/core",
      "@opentelemetry/exporter-trace-otlp-http",
      "@opentelemetry/instrumentation-express",
      "@opentelemetry/instrumentation-http",
      "@opentelemetry/instrumentation",
      "@opentelemetry/resources",
      "@opentelemetry/sdk-trace-base",
      "@opentelemetry/sdk-trace-node",
      "@opentelemetry/semantic-conventions",

      "@prisma/instrumentation",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-dialog",
      "@radix-ui/react-label",
      "@radix-ui/react-popover",
      "@radix-ui/react-radio-group",
      "@radix-ui/react-select",
      "@radix-ui/react-slider",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@radix-ui/react-tooltip",
      "@react-email/components",
      "@react-email/render",
      "@remix-run/node",
      "@remix-run/server-runtime",
      "@slack/web-api",
      "@socket.io/redis-adapter",
      "@tanstack/react-virtual",
      "@team-plain/typescript-sdk",
      "@whatwg-node/fetch",
      "aws4fetch",
      "cron-parser",
      "cronstrue",
      "evt",
      "fsevents",
      "graphile-worker",
      "https",
      "ioredis",
      "jsonpointer",
      "lodash.omit",
      "nanoid",
      "ohash",
      "parse-duration",
      "posthog-node",
      "prism-react-renderer",
      "prom-client",
      "random-words",
      "react-use/esm/useEvent",
      "remix-auth-email-link",
      "remix-auth-github",
      "remix-auth",
      "resend",
      "seedrandom",
      "simple-oauth2",
      "slug",
      "socket.io-client",
      "socket.io",
      "superjson",
      "ulid",
      "ulidx",
      "util",
      "ws",
      "zod-error",
    ],
  },
  build: {
    minify: true,
    cssCodeSplit: false,
    target: "esnext",
    cssMinify: MODE === "production",
    rollupOptions: {
      external: [/node:.*/, /.*\.node$/, "https", "stream", "crypto", "fsevents", "deepmerge"],
    },
  },

  server: {
    hmr: {
      port: 8002,
    },
    strictPort: true,
    port: Number(process.env.PORT),
    warmup: {
      clientFiles: ["./app/entry.client.tsx", "./app/root.tsx", "./app/routes/**/*"],
    },
  },

  plugins: [
    expressDevServer({
      exportName: "express",
      async configureServer(server) {
        if (!server) return;

        const { registerSocketIo } = await import("./app/socket.server");
        registerSocketIo(server);
      },
    }),
    remix({
      ignoredRouteFiles: ["**/.*"],
      serverModuleFormat: "esm",
    }).filter((plugin) => plugin.name !== "remix-dot-server"),
    tsconfigPaths() as Plugin,
    viteCommonjs() as Plugin,
    denyImports({
      client: {
        specifiers: ["@trigger.dev/core"],
      },
      server: {
        specifiers: ["@trigger.dev/core"],
      },
    }),
  ],
});
