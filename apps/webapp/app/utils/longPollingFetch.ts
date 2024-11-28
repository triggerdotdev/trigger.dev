// When proxying long-polling requests, content-encoding & content-length are added
// erroneously (saying the body is gzipped when it's not) so we'll just remove
// them to avoid content decoding errors in the browser.
//

import { logger } from "~/services/logger.server";

// Similar-ish problem to https://github.com/wintercg/fetch/issues/23
export async function longPollingFetch(
  url: string,
  options?: RequestInit,
  rewriteResponseHeaders?: Record<string, string>
) {
  try {
    let response = await fetch(url, options);

    if (response.headers.get("content-encoding")) {
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");

      response = new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    }

    if (rewriteResponseHeaders) {
      const headers = new Headers(response.headers);

      for (const [fromKey, toKey] of Object.entries(rewriteResponseHeaders)) {
        const value = headers.get(fromKey);
        if (value) {
          headers.set(toKey, value);
          headers.delete(fromKey);
        }
      }

      response = new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    }

    return response;
  } catch (error) {
    if (error instanceof TypeError) {
      // Network error or other fetch-related errors
      logger.error("Network error:", { error: error.message });
      throw new Response("Network error occurred", { status: 503 });
    } else if (error instanceof Error) {
      // HTTP errors or other known errors
      logger.error("Fetch error:", { error: error.message });
      throw new Response(error.message, { status: 500 });
    } else {
      // Unknown errors
      logger.error("Unknown error occurred during fetch");
      throw new Response("An unknown error occurred", { status: 500 });
    }
  }
}
