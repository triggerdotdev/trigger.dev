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
    "@trigger.dev/core-backend",
    "@trigger.dev/sdk",
    "emails",
    "highlight.run",
    "random-words",
  ],
  watchPaths: async () => {
    return [
      "../../packages/core/src/**/*",
      "../../packages/core-backend/src/**/*",
      "../../packages/trigger-sdk/src/**/*",
      "../../packages/emails/src/**/*",
    ];
  },
};
