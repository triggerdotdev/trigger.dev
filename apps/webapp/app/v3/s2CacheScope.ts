// Cached S2 read tokens are issued by whichever S2 service the endpoint names, and Redis outlives
// a restart, so a key scoped only by project would serve a token from the previous service after
// the endpoint changes. Hosted keeps its existing unscoped keys so nothing is invalidated.
export function s2CacheScope(endpoint: string | undefined): string {
  return endpoint === undefined ? "" : `endpoint:${endpoint}:`;
}
