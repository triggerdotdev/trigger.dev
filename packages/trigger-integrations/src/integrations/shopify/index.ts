import { getTriggerRun } from "@trigger.dev/sdk";
import { z } from "zod";
import { shopify } from "internal-providers";

export async function getProducts(key: string): Promise<any> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call getProducts outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "slack",
    endpoint: "chat.postMessage",
    params: {},
    response: {
      schema: z.any(),
    },
  });

  return output;
}
