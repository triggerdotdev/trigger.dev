import { z } from "zod";
import { createSSELoader } from "~/utils/sse";

export const loader = createSSELoader({
  timeout: 10_000,
  interval: 1_000,
  debug: false,
  handler: async ({ id, controller, debug, request }) => {
    const url = new URL(request.url);
    const searchParams = Object.fromEntries(url.searchParams.entries());

    const options = z
      .object({
        undefinedProbability: z.coerce.number().min(0).max(1).default(0.1),
      })
      .parse(searchParams);

    return {
      beforeStream: async () => {},
      initStream: async ({ send }) => {
        send({ data: new Date().toISOString() });
      },
      iterator: async ({ send, date }) => {
        if (Math.random() < options.undefinedProbability) {
          return;
        }

        send({ data: new Date().toISOString() });
      },
      cleanup: async () => {},
    };
  },
});
