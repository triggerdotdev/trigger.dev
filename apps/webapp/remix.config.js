/** @type {import('@remix-run/dev').AppConfig} */
module.exports = {
  cacheDirectory: "./node_modules/.cache/remix",
  ignoredRouteFiles: ["**/.*"],
  devServerPort: 8002,
  serverDependenciesToBundle: [
    "@apihero/internal-nobuild",
    "pretty-bytes",
    "marked",
    "@cfworker/json-schema",
    "@apihero/node",
  ],
  watchPaths: async () => {
    return ["../../packages/internal-nobuild/src/**/*"];
  },
};
