import { type HttpSourceRequest } from "~/services/endpointApi.server";
import { requestUrl } from "./requestUrl.server";

export async function createHttpSourceRequest(request: Request): Promise<HttpSourceRequest> {
  const url = requestUrl(request);
  let arrayBuffer: ArrayBuffer | undefined;
  try {
    arrayBuffer = await request.arrayBuffer();
  } catch (e) {}

  return {
    headers: Object.fromEntries(request.headers) as Record<string, string>,
    url: url.href,
    method: request.method,
    rawBody: arrayBuffer ? Buffer.from(arrayBuffer) : undefined,
  };
}
