import { eventFilterMatches } from "./eventFilterMatches.js";
import { HttpMethod, RequestFilter, ResponseFilter } from "./schemas/requestFilter.js";

export async function requestFilterMatches(
  request: Request,
  filter: RequestFilter
): Promise<boolean> {
  const clonedRequest = request.clone();
  if (!requestMethodMatches(clonedRequest.method as HttpMethod, filter.method)) {
    return false;
  }

  const headersObj = Object.fromEntries(clonedRequest.headers.entries());
  if (filter.headers && !eventFilterMatches(headersObj, filter.headers)) {
    return false;
  }

  const searchParams = new URL(clonedRequest.url).searchParams;
  const searchParamsObject: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    searchParamsObject[key] = value;
  }

  if (filter.query && !eventFilterMatches(searchParamsObject, filter.query)) {
    return false;
  }

  try {
    const json = await clonedRequest.json();
    if (filter.body && !eventFilterMatches(json, filter.body)) {
      return false;
    }
  } catch (e) {
    if (filter.body) {
      return false;
    }
  }

  return true;
}

export type ResponseFilterMatchResult = {
  match: boolean;
  body?: unknown;
};

export async function responseFilterMatches(
  response: Response,
  filter: ResponseFilter
): Promise<ResponseFilterMatchResult> {
  if (filter.headers && !eventFilterMatches(response.headers, filter.headers)) {
    return { match: false };
  }

  try {
    const json = await response.json();
    if (filter.body && !eventFilterMatches(json, filter.body)) {
      return { match: false, body: json };
    } else {
      return { match: true, body: json };
    }
  } catch (e) {
    if (filter.body) {
      return { match: false, body: undefined };
    }
  }

  return { match: true, body: undefined };
}

function requestMethodMatches(method: HttpMethod, filter: RequestFilter["method"]): boolean {
  if (!filter) {
    return true;
  }

  return filter.includes(method);
}
