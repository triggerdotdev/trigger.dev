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
    "Navigate the user to a specific dashboard page, or deep-link directly to a run " +
    "(and optionally a specific span/subtrace within it). Use when the user asks " +
    "'where do I find X', 'take me to Y', 'show me the Z page', 'go to settings', or " +
    "'open run run_…' / 'take me to that run'. Returns a URL that the frontend renders " +
    "as a clickable link and auto-navigates to during live chat.",
  inputSchema: z.object({
    destination: z
      .string()
      .optional()
      .describe(
        "A named section to go to, e.g. 'runs page', 'environment variables', " +
          "'deployment settings', 'error alerts', 'concurrency configuration'. " +
          "Omit when deep-linking to a run via runId."
      ),
    runId: z
      .string()
      .optional()
      .describe(
        "Deep-link to a specific run by its friendly ID (e.g. 'run_cmpy8wwvg0006htra3f5jtr8i'). " +
          "Opens the run detail / trace view. Takes precedence over destination."
      ),
    spanId: z
      .string()
      .optional()
      .describe(
        "When deep-linking to a run, optionally select a specific span (subtrace) in the " +
          "trace view by its span ID. Requires runId."
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

// V1B Runs domain tools
export const listRuns = tool({
  description:
    "List recent runs with optional filters by status, task, time period, and tags. " +
    "Use to help the user find specific runs or understand run patterns.",
  inputSchema: z.object({
    status: z
      .array(z.string())
      .optional()
      .describe(
        "Filter by run status. Valid statuses: PENDING, DELAYED, DEQUEUED, EXECUTING, " +
          "WAITING_TO_RESUME, COMPLETED_SUCCESSFULLY, COMPLETED_WITH_ERRORS, TIMED_OUT, " +
          "CRASHED, SYSTEM_FAILURE, CANCELED, EXPIRED. For 'failed' runs pass " +
          "[COMPLETED_WITH_ERRORS, CRASHED, TIMED_OUT, SYSTEM_FAILURE]; for 'successful' pass " +
          "[COMPLETED_SUCCESSFULLY]; for 'running' pass [EXECUTING]."
      ),
    taskIdentifier: z.string().optional().describe("Filter by task identifier"),
    period: z.string().optional().describe("Time period filter (e.g., '1h', '24h', '7d')"),
    tags: z.array(z.string()).optional().describe("Filter by tags"),
    limit: z.number().optional().default(20).describe("Maximum number of runs to return"),
  }),
});

export const getRunDetails = tool({
  description:
    "Get detailed information about a specific run, including status, timing, and trace summary. " +
    "Use when the user wants to investigate a particular run.",
  inputSchema: z.object({
    runFriendlyId: z.string().describe("The friendly ID of the run"),
  }),
});

export const getSpanDetails = tool({
  description:
    "Get the full detail of a single span (subtrace) within a run's trace, including its " +
    "error/exception (message + stack trace), log level, span events, properties, and metadata. " +
    "First call getRunDetails to list the trace's spans, then pass a span's `id` here as `spanId` " +
    "to drill into the one that failed. Use this to answer 'look at the subtrace and tell me exactly " +
    "what and why caused the error'. If the span is itself a triggered child run, also returns that " +
    "run's error and output.",
  inputSchema: z.object({
    runFriendlyId: z
      .string()
      .describe("The friendly ID of the run that owns the trace (e.g. 'run_…')"),
    spanId: z
      .string()
      .describe("The span ID to inspect — the `id` field from a span in getRunDetails' trace"),
  }),
});

export const getRunLogs = tool({
  description:
    "Fetch log lines from a specific run, optionally filtered by log level. " +
    "Returns formatted log lines with timestamps.",
  inputSchema: z.object({
    runFriendlyId: z.string().describe("The friendly ID of the run"),
    level: z
      .enum(["debug", "info", "warn", "error"])
      .optional()
      .describe("Filter by log level"),
    limit: z.number().optional().default(50).describe("Maximum number of log lines to return"),
  }),
});

export const getRunGraph = tool({
  description:
    "Get the hierarchical structure of a run, including parent and child runs. " +
    "Useful for understanding task dependencies and call chains.",
  inputSchema: z.object({
    runFriendlyId: z.string().describe("The friendly ID of the run"),
  }),
});

export const applyRunFilters = tool({
  description:
    "Convert natural language description into structured filters for the runs list. " +
    "Returns filters as URL parameters that can be applied to the runs page.",
  inputSchema: z.object({
    description: z.string().describe("Natural language description of filters (e.g., 'failed runs in the last 24 hours')"),
  }),
});

export const queryRuns = tool({
  description:
    "Convert natural language questions into SQL queries executed against ClickHouse. " +
    "Use for analytics and trend analysis. Returns structured query results.",
  inputSchema: z.object({
    question: z.string().describe("Natural language question about runs (e.g., 'what is the failure rate for the email task?')"),
  }),
});

// V1B Errors domain tools
export const listErrors = tool({
  description:
    "List error groups (unique errors) with their occurrence counts and timing. " +
    "Use to identify common failure patterns and most frequent errors.",
  inputSchema: z.object({
    period: z.string().optional().describe("Time period (e.g., '1h', '24h', '7d')"),
    taskIdentifier: z.string().optional().describe("Filter by task identifier"),
    limit: z.number().optional().default(20).describe("Maximum number of error groups to return"),
  }),
});

export const getErrorDetails = tool({
  description:
    "Get detailed information about a specific error group, including stack trace, " +
    "affected runs sample, and timing. Use to understand a specific error in depth.",
  inputSchema: z.object({
    fingerprint: z.string().describe("The error fingerprint identifying the error group"),
  }),
});

export const findSimilarErrors = tool({
  description:
    "Search for error groups with similar messages. Useful for finding patterns or regressions across tasks.",
  inputSchema: z.object({
    errorMessage: z.string().describe("The error message to search for similar errors"),
    limit: z.number().optional().default(10).describe("Maximum number of similar errors to return"),
  }),
});

export const classifyFailure = tool({
  description:
    "Classify the cause of a run failure into categories like timeout, OOM, missing env var, etc. " +
    "Uses AI analysis of run details and logs to determine the most likely failure reason.",
  inputSchema: z.object({
    runFriendlyId: z.string().describe("The friendly ID of the run to classify"),
  }),
});

// V1B Analytics domain tools
export const summarizeCurrentView = tool({
  description:
    "Get a summary of the current view: total runs, status distribution, top failing tasks, and error rate trend. " +
    "Use to understand the overall health of the system.",
  inputSchema: z.object({
    period: z.string().optional().describe("Time period for summary (e.g., '1h', '24h', '7d')"),
  }),
});

export const aggregateRuns = tool({
  description:
    "Compute aggregated metrics (count, failure rate, duration) for runs grouped by task, status, version, or queue. " +
    "Use for performance analysis and bottleneck identification.",
  inputSchema: z.object({
    groupBy: z
      .enum(["task", "status", "version", "queue"])
      .describe("Dimension to group by"),
    metric: z
      .enum(["count", "failureRate", "avgDuration", "p95Duration"])
      .optional()
      .describe("Metric to compute"),
    period: z.string().optional().describe("Time period (e.g., '1h', '24h', '7d')"),
  }),
});

export const correlateRunsWithDeploy = tool({
  description:
    "Analyze failure rates by deployment version to identify deploy regressions. " +
    "Shows correlation between deployments and failure patterns.",
  inputSchema: z.object({
    taskIdentifier: z.string().optional().describe("Filter by task identifier"),
    period: z.string().optional().describe("Time period (e.g., '1h', '24h', '7d')"),
  }),
});

// Tool labels for UI display (3-4 words max, action-oriented)
export const toolLabels: Record<string, string> = {
  searchDocs: "Searching documentation",
  navigateToPage: "Navigating to page",
  getCurrentContext: "Checking current context",
  searchPages: "Searching dashboard pages",
  listRuns: "Querying task runs",
  getRunDetails: "Loading run details",
  getSpanDetails: "Inspecting subtrace",
  getRunLogs: "Fetching run logs",
  getRunGraph: "Building run hierarchy",
  applyRunFilters: "Applying run filters",
  queryRuns: "Running analytics query",
  listErrors: "Loading error groups",
  getErrorDetails: "Loading error details",
  findSimilarErrors: "Finding similar errors",
  classifyFailure: "Classifying run failure",
  summarizeCurrentView: "Analyzing current view",
  aggregateRuns: "Computing aggregations",
  correlateRunsWithDeploy: "Checking deploy correlation",
};