/** @type {import('@remix-run/dev').AppConfig} */
module.exports = {
  cacheDirectory: "./node_modules/.cache/remix",
  ignoredRouteFiles: ["**/.*"],
  devServerPort: 8002,
  serverDependenciesToBundle: [
    "pretty-bytes",
    "marked",
    "@cfworker/json-schema",
    "@nangohq/pizzly-frontend",
    "@nangohq/pizzly-node",
    "axios",
    "internal-platform",
    "@trigger.dev/common-schemas",
  ],
  watchPaths: async () => {
    return [
      "../../packages/internal-platform/src/**/*",
      "../../packages/common-schemas/src/**/*",
    ];
  },
};
