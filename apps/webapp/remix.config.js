/** @type {import('@remix-run/dev').AppConfig} */
module.exports = {
  dev: {
    port: 8002,
  },
  tailwind: true,
  cacheDirectory: "./node_modules/.cache/remix",
  ignoredRouteFiles: ["**/.*"],
  serverModuleFormat: "cjs",
  serverDependenciesToBundle: [
    /^remix-utils.*/,
    "marked",
    "axios",
    "@internal/redis-worker",
    "p-limit",
    "yocto-queue",
    "@trigger.dev/core",
    "@trigger.dev/sdk",
    "@trigger.dev/platform",
    "@trigger.dev/yalt",
    "@unkey/cache",
    "@unkey/cache/stores",
    "emails",
    "highlight.run",
    "random-words",
    "superjson",
    "prismjs/components/prism-json",
    "prismjs/components/prism-typescript",
    "@internal/run-engine",
    "@internal/redis",
    "@internal/tracing",
  ],
  browserNodeBuiltinsPolyfill: { modules: { path: true, os: true, crypto: true } },
  watchPaths: async () => {
    return ["../../packages/core/src/**/*", "../../packages/emails/src/**/*"];
  },
};
