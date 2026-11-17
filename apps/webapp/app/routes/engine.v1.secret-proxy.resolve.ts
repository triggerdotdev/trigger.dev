import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { secretProxy } from "~/services/secretProxy/instance.server";
import { resolveSecretProxyRequest } from "~/services/secretProxy/resolveAction.server";

const headers = { "Cache-Control": "no-store", Pragma: "no-cache" };
const RESOLVE_PATH = "/engine/v1/secret-proxy/resolve";

// Served only by the private engine service; every other service answers as if the route did not exist.
function notFound() {
  return json({ error: "Not found" }, { status: 404, headers });
}

// The public load balancer blocks this path by its raw spelling, but the router matches after
// percent-decoding and case-folding. Only the exact spelling the relay sends is served.
function served(request: Request) {
  return env.SECRET_PROXY_RESOLVER_ENABLED && new URL(request.url).pathname === RESOLVE_PATH;
}

export function action({ request }: ActionFunctionArgs) {
  if (!served(request)) return notFound();
  return resolveSecretProxyRequest(secretProxy(), request);
}

export function loader({ request }: ActionFunctionArgs) {
  if (!served(request)) return notFound();
  return json({ error: "Method not allowed" }, { status: 405, headers });
}
