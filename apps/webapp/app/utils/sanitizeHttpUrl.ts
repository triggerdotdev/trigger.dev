const AUTHORIZATION_CODE_PATH_PREFIX = "/account/authorization-code/";
const REDACTED_AUTHORIZATION_CODE_PATH = "/account/authorization-code/[redacted]";
const ROUTER_PATH = Symbol.for("trigger.routerPath");

type RequestTarget = {
  originalUrl?: string;
  url?: string;
  hostname?: string;
  [ROUTER_PATH]?: string | null;
};

export function getRouterPath(request: RequestTarget): string | undefined {
  const cached = request[ROUTER_PATH];
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const target = request.originalUrl ?? request.url;
  if (!target) {
    request[ROUTER_PATH] = null;
    return undefined;
  }

  try {
    // Build the URL the way @remix-run/express does: the host concatenated in front of the
    // request target, not the target resolved against a base. Resolving treats `//x/api/...`
    // and absolute-form targets differently from Remix, and ignores a Host that moves the path.
    // Protocol and port can't change how the path parses, so they're left out.
    const host = request.hostname || "localhost";
    const pathname = normalizeLikeRouter(new URL(`http://${host}${target}`).pathname);
    request[ROUTER_PATH] = pathname;
    return pathname;
  } catch {
    request[ROUTER_PATH] = null;
    return undefined;
  }
}

/**
 * Remix decodes each path segment (keeping an encoded `/` as `%2F`) and matches routes
 * case-insensitively, so `/%61pi/v1/runs` and `/API/v1/runs` both reach `api.v1.runs`.
 * Middleware that only applies to some paths must match the same form, or an encoded or
 * uppercase path reaches the route without it. Lowercased because every path matcher in
 * the server is written in lowercase.
 */
function normalizeLikeRouter(pathname: string): string {
  let decoded: string;
  try {
    decoded = pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/\//g, "%2F"))
      .join("/");
  } catch {
    // Remix falls back to the raw path when a segment is malformed, and so do we.
    decoded = pathname;
  }
  return decoded.toLowerCase();
}

export function pathHasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function sanitizeHttpUrl(value: string): string {
  const queryIndex = value.indexOf("?");
  const path = queryIndex === -1 ? value : value.slice(0, queryIndex);

  return path.startsWith(AUTHORIZATION_CODE_PATH_PREFIX) ? REDACTED_AUTHORIZATION_CODE_PATH : path;
}
