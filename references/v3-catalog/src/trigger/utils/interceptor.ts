import { retry } from "@trigger.dev/sdk/v3";
import { HttpResponse, delay, http } from "msw";

export const interceptor = retry.interceptFetch(
  http.get("http://my.host/test-headers", ({ request }) => {
    const retryCount = request.headers.get("x-retry-count");

    if (retryCount === "1") {
      return new HttpResponse(null, {
        status: 429,
        headers: {
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Date.now() + 1000 * 10), // 10 seconds
        },
      });
    }

    return HttpResponse.json({ test: "headers" });
  }),
  http.get("http://my.host/test-backoff", ({ request }) => {
    const retryCount = request.headers.get("x-retry-count");

    if (retryCount === "4") {
      return HttpResponse.json({ test: "backoff" });
    }

    return new HttpResponse(null, {
      status: 500,
    });
  }),
  http.get("http://my.host/test-connection-errors", ({ request }) => {
    const retryCount = request.headers.get("x-retry-count");

    if (retryCount === "2") {
      return HttpResponse.json({ test: "connection-errors" });
    }

    return HttpResponse.error();
  })
);
