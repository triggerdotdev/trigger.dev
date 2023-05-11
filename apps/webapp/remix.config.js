/** @type {import('@remix-run/dev').AppConfig} */
module.exports = {
  future: {
    unstable_tailwind: true,
    // v2_routeConvention: true,
    // v2_meta: true,
  },
  cacheDirectory: "./node_modules/.cache/remix",
  ignoredRouteFiles: ["**/.*"],
  devServerPort: 8002,
  serverDependenciesToBundle: [
    "pretty-bytes",
    "marked",
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
