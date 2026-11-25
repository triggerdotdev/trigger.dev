import { apiProxyOptions } from "@/lib/api-proxy";
import { openapi } from "@/lib/source";

// The API playground sends requests through here: many API routes don't answer CORS preflights,
// so a browser can't call them directly. Only the API origins are reachable (no open proxy). Only
// the API's own request headers go upstream (no cookies), and responses' Set-Cookie is dropped.
const proxy = openapi.createProxy(
  apiProxyOptions(["https://api.trigger.dev", process.env.DOCS_API_SERVER_URL])
);

export const { GET, POST, PUT, DELETE, PATCH, HEAD } = proxy;
