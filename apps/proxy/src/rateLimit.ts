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
    const result = await env.API_RATE_LIMITER.limit({ key: `apikey-${apiKey.apiKey}` });
    const { success } = result;
    console.log(`Rate limiter`, {
      success,
      key: `${apiKey.apiKey.substring(0, 12)}...`,
    });
    if (!success) {
      //60s in the future
      const reset = Date.now() + 60 * 1000;
      const secondsUntilReset = Math.max(0, (reset - new Date().getTime()) / 1000);

      return json(
        {
          title: "Rate Limit Exceeded",
          status: 429,
          type: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429",
          detail: `Rate limit exceeded. Retry in ${secondsUntilReset} seconds.`,
          error: `Rate limit exceeded. Retry in ${secondsUntilReset} seconds.`,
          reset,
        },
        {
          status: 429,
          headers: {
            "x-ratelimit-reset": reset.toString(),
          },
        }
      );
    }
  } else {
    console.log(`Rate limiter: no API key for request`);
  }

  //call the original function
  return fn();
}
