import { LoaderArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { sse } from "~/utils/sse";

export async function loader({ request }: LoaderArgs) {
  const url = new URL(request.url);
  const searchParams = Object.fromEntries(url.searchParams.entries());

  const options = z
    .object({
      minDelay: z.coerce.number().int(),
      maxDelay: z.coerce.number().int(),
      undefinedProbability: z.coerce.number().min(0).max(1).default(0.1),
    })
    .parse(searchParams);

  logger.debug("Test SSE stream", { options });

  let lastSignals = calculateChangeSignals(Date.now());

  return sse({
    request,
    run: async (send, stop) => {
      const result = await dateForUpdates(options);

      if (!result) {
        return stop();
      }

      const newSignals = calculateChangeSignals(result);

      if (lastSignals.ts !== newSignals.ts) {
        send({ data: JSON.stringify(newSignals) });
      }

      lastSignals = newSignals;
    },
  });
}

async function dateForUpdates(opts: {
  minDelay: number;
  maxDelay: number;
  undefinedProbability: number;
}): Promise<number | undefined> {
  // Randomly await between minDelay and maxDelay
  await new Promise((resolve) => {
    setTimeout(resolve, Math.random() * (opts.maxDelay - opts.minDelay) + opts.minDelay);
  });

  // There should be about a x% chance that this returns undefined
  if (Math.random() < opts.undefinedProbability) {
    logger.debug("Test SSE dataForUpdates returning undefined");

    return undefined;
  }

  // Randomly return true or false
  return Date.now();
}

function calculateChangeSignals(ts: number) {
  return {
    ts,
  };
}
