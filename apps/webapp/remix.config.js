/** @type {import('@remix-run/dev').AppConfig} */
module.exports = {
  future: {
    v2_dev: true,
    v2_routeConvention: true,
    v2_normalizeFormMethod: true,
    v2_errorBoundary: true,
    // v2_meta: true,
  },
  tailwind: true,
  cacheDirectory: "./node_modules/.cache/remix",
  ignoredRouteFiles: ["**/.*"],
  devServerPort: 8002,
  serverModuleFormat: "cjs",
  serverDependenciesToBundle: [
    "pretty-bytes",
    "marked",
    "axios",
    "@trigger.dev/internal",
    "emails",
    "@octokit/webhooks",
    "highlight.run",
  ],
  watchPaths: async () => {
    return [
      "../../packages/internal/src/**/*",
      "../../packages/emails/src/**/*",
    ];
  },
};
