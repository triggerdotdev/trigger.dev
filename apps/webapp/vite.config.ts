import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { installGlobals } from "@remix-run/node";
import { config } from "dotenv";
import { expand } from "dotenv-expand";
expand(
  config({
    path: "../../.env",
  })
);

installGlobals({ nativeFetch: true });

const MODE = process.env.NODE_ENV;

export default defineConfig({
  ssr: {
    noExternal: ["react-use"],
  },
  
  optimizeDeps: {
    // Include CJS deps or any with lots of internal modules
    include: [
      "@codemirror/autocomplete",
      "@codemirror/commands",
      "@codemirror/lang-json",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@internationalized/date",
      "@lezer/highlight",
      "@react-aria/datepicker",
      "@react-stately/datepicker",
      "@trigger.dev/billing",
      "@trigger.dev/companyicons",
      "@trigger.dev/otlp-importer",
      "@trigger.dev/sdk",
      "@trigger.dev/yalt",
      "@uiw/react-codemirror",
      "assert-never",
      "cookie",
      "humanize-duration",
      "react-dom",
      "react-dom/client",
      "react-popper",
      "react-resizable-panels",
      "react",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
      "recharts",
      "set-cookie-parser",
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
      external: ["https"],
    },
  },

  server: {
    hmr: {
      port: 8002,
    },
    port: Number(process.env.PORT),
  },

  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      serverModuleFormat: "esm",
    }),
    tsconfigPaths(),
  ],
});
