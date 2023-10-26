import { HttpSourceRequest } from "@trigger.dev/core";
import { requestUrl } from "./requestUrl.server";

export async function createHttpSourceRequest(request: Request): Promise<HttpSourceRequest> {
  const url = requestUrl(request);
  return {
    headers: Object.fromEntries(request.headers) as Record<string, string>,
    url: url.href,
    method: request.method,
    rawBody: ["POST", "PUT", "PATCH"].includes(request.method)
      ? Buffer.from(await request.arrayBuffer())
      : undefined,
  };
}
