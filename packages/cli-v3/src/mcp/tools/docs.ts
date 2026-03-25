import { z } from "zod";
import { toolsMetadata } from "../config.js";
import { toolHandler } from "../utils.js";
import { performSearch } from "../mintlifyClient.js";

export const searchDocsTool = {
  name: toolsMetadata.search_docs.name,
  title: toolsMetadata.search_docs.title,
  description: toolsMetadata.search_docs.description,
  inputSchema: {
    query: z.string(),
  },
  handler: toolHandler({ query: z.string() }, async (input, { ctx, signal }) => {
    ctx.logger?.log("calling search_docs", { input });

    const results = await performSearch(input.query, signal);

    return results.result;
  }),
};
