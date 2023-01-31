import type {
  HTTPMethod,
  NormalizedRequest,
} from "@trigger.dev/integration-sdk";
import { httpMethods } from "@trigger.dev/integration-sdk";

export async function createNormalizedRequest(
  request: Request
): Promise<NormalizedRequest> {
  const requestUrl = new URL(request.url);
  const rawSearchParams = requestUrl.searchParams;
  const rawBody = await request.text();
  const rawHeaders = Object.fromEntries(request.headers.entries());

  if (!isMethod(request.method)) {
    throw new Error(`Invalid method: ${request.method}`);
  }

  return {
    rawBody,
    body: safeJsonParse(rawBody),
    headers: rawHeaders,
    searchParams: rawSearchParams,
    method: request.method,
  };
}

function safeJsonParse(json: string): any {
  try {
    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}

function isMethod(str: string): str is HTTPMethod {
  return !!httpMethods.find((method) => str === method);
}
