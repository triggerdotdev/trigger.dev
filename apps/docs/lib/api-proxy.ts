import type { CreateProxyOptions } from "fumadocs-openapi/server";

// The only request headers the API needs. Everything else stays behind: the reader's cookies (the
// library forwards them, and honours `?cookie=`, once `allowedOrigins` is set), and the headers
// the edge adds to every docs request (the proxy secret and the client IP).
const FORWARDED = new Set(["authorization", "content-type", "accept", "idempotency-key"]);

function forwardedOnly(request: Request): Request {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (FORWARDED.has(key) || key.startsWith("x-trigger-")) headers.set(key, value);
  });
  return new Request(request, { headers });
}

function withoutCookies(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function apiProxyOptions(origins: (string | undefined)[]): CreateProxyOptions {
  return {
    allowedOrigins: origins.filter((origin): origin is string => !!origin),
    overrides: { request: forwardedOnly, response: withoutCookies },
  };
}
