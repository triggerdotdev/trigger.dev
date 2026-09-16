const AUTHORIZATION_CODE_PATH_PREFIX = "/account/authorization-code/";
const REDACTED_AUTHORIZATION_CODE_PATH = "/account/authorization-code/[redacted]";
const ROUTER_PATH = Symbol.for("trigger.routerPath");

type RequestTarget = {
  originalUrl?: string;
  url?: string;
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
    const pathname = new URL(target, "http://localhost").pathname;
    request[ROUTER_PATH] = pathname;
    return pathname;
  } catch {
    request[ROUTER_PATH] = null;
    return undefined;
  }
}

export function pathHasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function sanitizeHttpUrl(value: string): string {
  const queryIndex = value.indexOf("?");
  const path = queryIndex === -1 ? value : value.slice(0, queryIndex);

  return path.startsWith(AUTHORIZATION_CODE_PATH_PREFIX) ? REDACTED_AUTHORIZATION_CODE_PATH : path;
}
