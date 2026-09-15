// A safe breadcrumb for logging an inbound API request. Must never include
// header *values*, only presence — the Authorization header carries the
// caller's credential. Dependency-free so it's unit-tested directly.
export function missingJwtLogContext(request: Request): {
  method: string;
  path: string;
  hasAuthorization: boolean;
} {
  const url = new URL(request.url);
  return {
    method: request.method,
    path: url.pathname,
    hasAuthorization: request.headers.has("authorization"),
  };
}
