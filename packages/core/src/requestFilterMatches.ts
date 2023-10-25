import { eventFilterMatches } from "./eventFilterMatches";
import { HttpMethod, RequestFilter, StringMatch } from "./schemas/requestFilter";

export async function requestFilterMatches(
  request: Request,
  filter: RequestFilter
): Promise<boolean> {
  if (!requestMethodMatches(request.method as HttpMethod, filter.method)) {
    return false;
  }

  if (filter.headers && !eventFilterMatches(request.headers, filter.headers)) {
    return false;
  }

  const searchParams = new URL(request.url).searchParams;
  const searchParamsObject: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    searchParamsObject[key] = value;
  }

  if (filter.query && !eventFilterMatches(searchParamsObject, filter.query)) {
    return false;
  }

  try {
    const json = await request.json();
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

function requestMethodMatches(method: HttpMethod, filter: RequestFilter["method"]): boolean {
  if (!filter) {
    return true;
  }

  return filter.includes(method);
}
