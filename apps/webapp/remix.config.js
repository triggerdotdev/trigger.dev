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
    /^@electric-sql.*/,
  ],
  browserNodeBuiltinsPolyfill: {
    modules: { path: true, os: true, crypto: true, fs: true, buffer: true },
  },
  watchPaths: async () => {
    return ["../../packages/core/src/**/*", "../../packages/emails/src/**/*", "./pglite/**/*"];
  },
};
