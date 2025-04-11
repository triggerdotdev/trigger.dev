import { logger, task } from "@trigger.dev/sdk/v3";
import { htmlToText } from "html-to-text";

export const scrape = task({
  id: "scrape-site",
  maxDuration: 300,
  run: async (payload: { url: string }) => {
    const response = await fetch(payload.url);
    const html = await response.text();
    const content = htmlToText(html);

    logger.info("Site scraped successfully", { url: payload.url });

    return {
      content,
    };
  },
});
