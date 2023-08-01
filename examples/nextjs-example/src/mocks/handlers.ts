// src/mocks/handlers.js
import { rest } from "msw";
import { z } from "zod";

export const handlers = [
  rest.get("https://api.github.com/repos/ericallam/triggerdotdev-test-repo", (req, res, ctx) => {
    const { "x-trigger-attempt": attempts } = z
      .object({
        "x-trigger-attempt": z.coerce.number().optional(),
      })
      .parse(Object.fromEntries(req.headers.entries()));

    if (typeof attempts === "number" && attempts > 2) {
      return req.passthrough();
    }

    // Return a rate-limited error
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const rateLimitResetTime = nowInSeconds + 10;

    return res(
      // Respond with a 200 status code
      ctx.status(403),
      // And a response body of an error
      ctx.json({
        message: "API rate limit exceeded",
        documentation_url:
          "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
      }),
      ctx.set({
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": rateLimitResetTime.toString(),
      })
    );
  }),
];
