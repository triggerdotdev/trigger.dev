import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { secretProxy } from "~/services/secretProxy/instance.server";
import { resolveSecretProxyRequest } from "~/services/secretProxy/resolveAction.server";

const headers = { "Cache-Control": "no-store", Pragma: "no-cache" };
const RESOLVE_PATH = "/engine/v1/secret-proxy/resolve";

function notFound() {
  return json({ error: "Not found" }, { status: 404, headers });
}

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
