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
    "internal-integrations",
    "internal-catalog",
    "@trigger.dev/common-schemas",
    "emails",
    "internal-pulsar",
  ],
  watchPaths: async () => {
    return [
      "../../packages/internal-platform/src/**/*",
      "../../packages/common-schemas/src/**/*",
      "../../packages/internal-integrations/src/**/*",
      "../../packages/internal-catalog/src/**/*",
      "../../packages/emails/src/**/*",
      "../../packages/internal-pulsar/src/**/*",
    ];
  },
};
