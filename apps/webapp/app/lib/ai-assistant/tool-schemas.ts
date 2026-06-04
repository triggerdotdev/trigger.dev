// Schema-only tool definitions. Execute functions live in
// app/trigger/ai-assistant-tools/ and spread these in, so descriptions are
// single-sourced. Keep this file dependency-light (only `ai` and `zod`) — no
// SDK runtime, Prisma, or Node built-ins.
import { tool } from "ai";
import { z } from "zod";

export const searchDocs = tool({
  description:
    "Search Trigger.dev documentation for guides, API reference, configuration, " +
    "troubleshooting, and help articles. Use when the user asks how a feature works, " +
    "how to configure something, or needs help with an error.",
  inputSchema: z.object({
    query: z.string().describe("Search query about Trigger.dev features or APIs"),
  }),
});

export const navigateToPage = tool({
  description:
    "Navigate the user to a specific dashboard page. Use when the user asks " +
    "'where do I find X', 'take me to Y', 'show me the Z page', or 'go to settings'. " +
    "Returns a URL that the frontend renders as a clickable link.",
  inputSchema: z.object({
    destination: z
      .string()
      .describe(
        "Where the user wants to go, e.g. 'runs page', 'environment variables', " +
          "'deployment settings', 'error alerts', 'concurrency configuration'"
      ),
  }),
});

export const getCurrentContext = tool({
  description:
    "Get information about what the user is currently viewing in the dashboard. " +
    "Returns the current project, environment, page, and any active parameters. " +
    "Use to ground your answers in the user's current context.",
  inputSchema: z.object({}),
});

export const searchPages = tool({
  description:
    "Search for available dashboard pages by description. Returns matching pages " +
    "with descriptions and URLs. Use when the user's destination is ambiguous or " +
    "you want to suggest relevant pages.",
  inputSchema: z.object({
    query: z.string().describe("Description of what the user is looking for"),
  }),
});

// Friendly labels for completed tool steps shown in the chat transcript.
export const toolLabels: Record<string, string> = {
  searchDocs: "Searched documentation",
  navigateToPage: "Navigated to page",
  getCurrentContext: "Checked current context",
  searchPages: "Searched dashboard pages",
};