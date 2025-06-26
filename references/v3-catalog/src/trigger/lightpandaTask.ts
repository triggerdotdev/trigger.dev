import { logger, task } from "@trigger.dev/sdk/v3";
import { execSync } from "node:child_process";

export const lightpandaFetch = task({
  id: "lightpanda-fetch",
  machine: {
    preset: "micro",
  },
  run: async (payload: { url: string }, { ctx }) => {
    logger.log("Lets get a page's content with Lightpanda!", { payload, ctx });

    if (!payload.url) {
      logger.warn("Please define the payload url");
      throw new Error("payload.url is undefined");
    }

    const e = execSync(`${process.env.LIGHTPANDA_BROWSER_PATH} fetch --dump ${payload.url}`);

    return {
      message: e.toString(),
    };
  },
});
