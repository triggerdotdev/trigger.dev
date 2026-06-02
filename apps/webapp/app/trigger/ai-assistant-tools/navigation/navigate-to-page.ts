import { tool } from "ai";
import { navigateToPage as navigateSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";
import { findBestMatch } from "./page-matcher";

export function createNavigateToPageTool(ctx: ToolContext) {
  return tool({
    ...navigateSchema,
    execute: async ({ destination }) => {
      const match = findBestMatch(destination);
      if (!match) {
        return {
          found: false,
          message: "I couldn't find that page. Try asking me to search for available pages.",
        };
      }
      return {
        found: true,
        pageName: match.id,
        description: match.description,
        url: match.pathFn(ctx.org, ctx.project, ctx.env),
      };
    },
  });
}