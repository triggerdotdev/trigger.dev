import { tool } from "ai";
import { searchPages as searchPagesSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";
import { findMatches } from "./page-matcher";

export function createSearchPagesTool(ctx: ToolContext) {
  return tool({
    ...searchPagesSchema,
    execute: async ({ query }) => {
      const matches = findMatches(query, 5);
      return {
        matches: matches.map((m) => ({
          pageName: m.id,
          description: m.description,
          url: m.pathFn(ctx.org, ctx.project, ctx.env),
        })),
        total: matches.length,
      };
    },
  });
}