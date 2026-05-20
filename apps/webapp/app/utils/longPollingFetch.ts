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
  let upstream: Response | undefined;
  try {
    upstream = await fetch(url, options);
    let response = upstream;

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
    // Release upstream undici socket + buffers explicitly. Without this the
    // ReadableStream stays open and undici keeps buffering chunks into memory
    // until the upstream times out (see H1 isolation test — ~44 KB retained
    // per unconsumed-body fetch in RSS).
    try { await upstream?.body?.cancel(); } catch {}

    // AbortError is the expected path when downstream disconnects with a
    // propagated signal — treat as a clean client-close, not a server error.
    if (error instanceof Error && error.name === "AbortError") {
      throw new Response(null, { status: 499 });
    }
    if (error instanceof TypeError) {
      logger.error("Network error:", { error: error.message });
      throw new Response("Network error occurred", { status: 503 });
    } else if (error instanceof Error) {
      logger.error("Fetch error:", { error: error.message });
      throw new Response(error.message, { status: 500 });
    } else {
      logger.error("Unknown error occurred during fetch");
      throw new Response("An unknown error occurred", { status: 500 });
    }
  }
}
