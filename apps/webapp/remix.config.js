/** @type {import('@remix-run/dev').AppConfig} */
module.exports = {
  tailwind: true,
  cacheDirectory: "./node_modules/.cache/remix",
  ignoredRouteFiles: ["**/.*"],
  dev: {
    port: 8002,
  },
  serverModuleFormat: "cjs",
  serverDependenciesToBundle: [
    "marked",
    "axios",
    "@trigger.dev/core",
    "@trigger.dev/sdk",
    "emails",
    "highlight.run",
  ],
  watchPaths: async () => {
    return [
      "../../packages/core/src/**/*",
      "../../packages/trigger-sdk/src/**/*",
      "../../packages/emails/src/**/*",
    ];
  },
};
