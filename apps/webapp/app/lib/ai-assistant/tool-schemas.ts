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

export const searchApi = tool({
  description:
    "Find Trigger.dev REST API operations relevant to what the user wants to do. " +
    "Runs an in-process search over the API and returns the top matches (operationId, " +
    "method, path, summary). ALWAYS call this before callApi — operationIds are not " +
    "guessable. Covers both read operations (list/retrieve) and actions (create, " +
    "update, cancel, delete, etc.).",
  inputSchema: z.object({
    query: z
      .string()
      .describe("What the user wants to do, e.g. 'list runs', 'cancel a run', 'create a schedule'"),
  }),
});

export const getApiDetails = tool({
  description:
    "Get the full schema for a REST API operation before calling it: every parameter " +
    "(name, location, type, required, allowed values, description), the request body " +
    "shape, and whether it changes state. ALWAYS call this after searchApi and before " +
    "callApi so you pass the right parameters instead of guessing.",
  inputSchema: z.object({
    operationId: z.string().describe("The operationId from a searchApi result"),
  }),
});

export const callApi = tool({
  description:
    "Execute a Trigger.dev REST API operation discovered via searchApi. Pass the " +
    "operationId and a flat params object: path params (e.g. runId), query params " +
    "(e.g. filter, page), and request-body fields all go directly in params. " +
    "projectRef and env are filled in automatically from the current context.\n\n" +
    "Read operations run immediately. Any operation that changes state (create, " +
    "update, cancel, delete, pause, replay, etc.) — or reveals a secret value — is " +
    "automatically paused for the user to approve in the UI before it runs; you do " +
    "NOT need to ask for confirmation in text. When calling such an operation, ALWAYS " +
    "set `intent` to one clear, specific sentence describing exactly what will happen " +
    "(it is shown verbatim on the approval prompt). If the user denies, the call does " +
    "not run — acknowledge and move on.",
  inputSchema: z.object({
    operationId: z.string().describe("The operationId from a searchApi result"),
    params: z
      .record(z.any())
      .optional()
      .describe("Path params, query params, and body fields as a single flat object"),
    intent: z
      .string()
      .optional()
      .describe(
        "One clear sentence describing what this call will do, e.g. 'Cancel run " +
          "run_abc123.' REQUIRED for any state-changing or secret-revealing operation — " +
          "it is shown to the user on the approval prompt."
      ),
  }),
});

export const executeTrql = tool({
  description:
    "Run a TRQL (SQL-style) analytical query against Trigger.dev data — runs, " +
    "metrics, and LLM usage tables. Use for any aggregation, count, trend, average, " +
    "cost breakdown, or comparison ('how many', 'total cost', 'failures per day'). " +
    "Call getQuerySchema first if you're unsure of table or column names. Queries are " +
    "read-only and scoped to the current environment by default.",
  inputSchema: z.object({
    query: z.string().describe("A read-only TRQL SELECT query, e.g. 'SELECT count() FROM runs WHERE status = ..'"),
    scope: z
      .enum(["organization", "project", "environment"])
      .optional()
      .describe("Tenant scope for the query. Defaults to environment."),
    period: z
      .string()
      .optional()
      .describe("Relative time window, e.g. '1d', '7d', '30d'. Defaults to 7d."),
    from: z.string().optional().describe("ISO start date (overrides period)"),
    to: z.string().optional().describe("ISO end date"),
  }),
});

export const getQuerySchema = tool({
  description:
    "Get the TRQL table schema: available tables (runs, metrics, llm_metrics, " +
    "llm_models), their columns, types, and allowed values. Call this before writing " +
    "a TRQL query when you're unsure of the exact table or column names.",
  inputSchema: z.object({}),
});

export const listDashboards = tool({
  description:
    "List Trigger.dev's pre-built dashboard definitions and their underlying TRQL " +
    "widget queries. Useful as worked examples when composing a new analytical query.",
  inputSchema: z.object({}),
});

// Friendly labels for completed tool steps shown in the chat transcript.
export const toolLabels: Record<string, string> = {
  searchDocs: "Searched documentation",
  navigateToPage: "Navigated to page",
  getCurrentContext: "Checked current context",
  searchPages: "Searched dashboard pages",
  searchApi: "Searched the API",
  getApiDetails: "Checked API details",
  callApi: "Called the API",
  executeTrql: "Queried your data",
  getQuerySchema: "Checked the data schema",
  listDashboards: "Listed dashboards",
};