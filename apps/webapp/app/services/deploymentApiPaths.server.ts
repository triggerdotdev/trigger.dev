// Deploy-flow endpoints, rate limited by deploymentRateLimiter with a separate
// budget instead of the general per-environment buckets.
export const deploymentApiPaths: (RegExp | string)[] = [
  // /current is runtime SDK surface, kept out of the deploy budget
  /^\/api\/v\d+\/deployments(?!\/current$)(\/|$)/,
  /^\/api\/v1\/projects\/[^/]+\/(dev|staging|prod|preview)$/,
  /^\/api\/v1\/projects\/[^/]+\/envvars$/,
  /^\/api\/v1\/projects\/[^/]+\/envvars\/[^/]+\/import$/,
  /^\/api\/v1\/projects\/[^/]+\/branches$/,
  /^\/api\/v1\/projects\/[^/]+\/branches\/archive$/,
  "/api/v1/remote-build-provider-status",
  "/api/v1/artifacts",
];
