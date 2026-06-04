import { tool } from "ai";
import { navigateToPage as navigateSchema } from "~/lib/ai-assistant/tool-schemas";
import { v3RunPath, v3RunSpanPath, v3TestTaskPath } from "~/utils/pathBuilder";
import type { ToolContext } from "../types";
import { findBestMatch } from "./page-matcher";

export function createNavigateToPageTool(ctx: ToolContext) {
  return tool({
    ...navigateSchema,
    execute: async ({ destination, runId, spanId, testTaskId }) => {
      // Deep-link to a task's Test page takes precedence — the user wants to test it.
      if (testTaskId) {
        const url = v3TestTaskPath(ctx.org, ctx.project, ctx.env, {
          taskIdentifier: testTaskId,
        });
        return {
          found: true,
          pageName: `Test ${testTaskId}`,
          description: "Test page for the task — fill a payload and run it",
          url,
        };
      }

      // Deep-link to a specific run (optionally a span within it) takes precedence
      // over a named-section lookup.
      if (runId) {
        const run = { friendlyId: runId };
        const url = spanId
          ? v3RunSpanPath(ctx.org, ctx.project, ctx.env, run, { spanId })
          : v3RunPath(ctx.org, ctx.project, ctx.env, run);
        return {
          found: true,
          pageName: spanId ? `Span in run ${runId}` : `Run ${runId}`,
          description: spanId
            ? "Run trace view with the selected span open"
            : "Run detail and trace view",
          url,
        };
      }

      if (!destination) {
        return {
          found: false,
          message:
            "I need either a page name or a run ID to navigate to. Try naming a page or a run.",
        };
      }

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
