// When proxying long-polling requests, content-encoding & content-length are added
// erroneously (saying the body is gzipped when it's not) so we'll just remove
// them to avoid content decoding errors in the browser.
//

import { logger } from "~/services/logger.server";

// Similar-ish problem to https://github.com/wintercg/fetch/issues/23
export async function longPollingFetch(url: string, options?: RequestInit) {
  try {
    let response = await fetch(url, options);

    // Check if the response is ok (status in the range 200-299)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    if (response.headers.get(`content-encoding`)) {
      const headers = new Headers(response.headers);
      headers.delete(`content-encoding`);
      headers.delete(`content-length`);
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
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
