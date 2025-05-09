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
    /^@internal\//, // Bundle all internal packages
    /^@trigger\.dev\//, // Bundle all trigger packages
    "marked",
    "axios",
    "p-limit",
    "yocto-queue",
    "@unkey/cache",
    "@unkey/cache/stores",
    "emails",
    "highlight.run",
    "random-words",
    "superjson",
    "prismjs/components/prism-json",
    "prismjs/components/prism-typescript",
    "redlock",
  ],
  browserNodeBuiltinsPolyfill: { modules: { path: true, os: true, crypto: true } },
};
