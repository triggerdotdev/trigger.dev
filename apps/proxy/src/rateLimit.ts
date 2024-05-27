import { Env } from "src";
import { getApiKeyFromRequest } from "./apikey";
import { json } from "./json";

export async function applyRateLimit(
  request: Request,
  env: Env,
  fn: () => Promise<Response>
): Promise<Response> {
  const apiKey = getApiKeyFromRequest(request);
  if (apiKey) {
    const { success } = await env.API_RATE_LIMITER.limit({ key: `apikey-${apiKey.apiKey}` });
    if (!success) {
      return json(
        {
          title: "Rate Limit Exceeded",
          status: 429,
          type: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429",
          detail: `Rate limit exceeded.`,
          error: `Rate limit exceeded.`,
        },
        {
          status: 429,
        }
      );
    }
  }

  //call the original function
  return fn();
}
