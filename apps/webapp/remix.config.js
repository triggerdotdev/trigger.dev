/** @type {import('@remix-run/dev').AppConfig} */
module.exports = {
  cacheDirectory: "./node_modules/.cache/remix",
  ignoredRouteFiles: ["**/.*"],
  devServerPort: 8002,
  serverDependenciesToBundle: [
    "pretty-bytes",
    "marked",
    "@cfworker/json-schema",
    "@nangohq/frontend",
    "@nangohq/node",
    "axios",
    "@trigger.dev/internal",
    "emails",
    "@octokit/webhooks",
  ],
  watchPaths: async () => {
    return [
      "../../packages/internal/src/**/*",
      "../../packages/emails/src/**/*",
    ];
  },
};
