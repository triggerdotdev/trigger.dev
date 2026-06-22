/**
 * Schema-only tool definitions + the default system prompt text, shared between
 * the chat.agent task and the webapp's `chat.headStart` route handler.
 *
 * HARD CONSTRAINT — bundle isolation. The head-start route imports this file
 * and runs it in the webapp process, so anything imported here lands in that
 * bundle. Allowed imports: `ai` (for `tool()`), `zod`, type-only AI SDK. Nothing
 * else — no `@internal/dashboard-agent-db`, no `@trigger.dev/sdk` runtime, no
 * `postgres`/`drizzle`. The `execute` fns (the data lane that calls the API as
 * the user) live in `tools.ts`, which imports these schemas and adds executes
 * on top; the route handler never sees them.
 */
import { tool } from "ai";
import { z } from "zod";

export const listProjectsSchema = tool({
  description:
    "List the Trigger.dev projects the user can access, with each project's ref, name, slug, and organization.",
  inputSchema: z.object({}),
});

export const listEnvironmentsSchema = tool({
  description:
    "List the environments (dev, staging, production, preview branches) for a project. Defaults to the current project when projectRef is omitted.",
  inputSchema: z.object({
    projectRef: z
      .string()
      .optional()
      .describe("Project ref like proj_... . Defaults to the current project."),
  }),
});

export const listTasksSchema = tool({
  description:
    "List the tasks deployed in the current environment's latest deployment, with each task's slug, file path, and trigger source.",
  inputSchema: z.object({}),
});

export const listRunsSchema = tool({
  description:
    "List recent runs in the current environment, newest first. Optionally filter by status, task, time period, or the error group they belong to. Use this for 'what's been running', 'recent failures', or 'show me the runs behind this error'.",
  inputSchema: z.object({
    status: z
      .string()
      .optional()
      .describe("Run status filter, e.g. COMPLETED, FAILED, EXECUTING, QUEUED, CANCELED."),
    taskIdentifier: z.string().optional().describe("Only runs of this task id."),
    errorId: z
      .string()
      .optional()
      .describe("Only runs that hit this error group (an error_... id from list_errors/get_error)."),
    period: z
      .string()
      .optional()
      .describe("Relative window, e.g. 1h, 24h, 7d. Max 30d; larger values are capped at 30d."),
    limit: z.number().int().positive().max(50).optional().describe("Max runs to return (default 10)."),
  }),
});

export const getRunSchema = tool({
  description:
    "Get the status, timing, cost, and error details for a single run in the current environment, by its run id (run_...).",
  inputSchema: z.object({
    runId: z.string().describe("The run id, e.g. run_abc123."),
  }),
});

export const getRunTraceSchema = tool({
  description:
    "Get a run's execution trace: the timeline of spans (tasks, waits, attempts) with durations and error flags. Use this to explain why a run failed, retried, or was slow.",
  inputSchema: z.object({
    runId: z.string().describe("The run id, e.g. run_abc123."),
  }),
});

export const listErrorsSchema = tool({
  description:
    "List error groups in the current environment: distinct errors grouped by fingerprint, with occurrence count, first/last seen, and lifecycle status (unresolved/resolved/ignored). Use this for 'what's broken', 'recent errors', 'top errors', etc.",
  inputSchema: z.object({
    status: z
      .string()
      .optional()
      .describe(
        "Filter by lifecycle status: unresolved, resolved, or ignored. Comma-separate for multiple. Defaults to all."
      ),
    taskIdentifier: z
      .string()
      .optional()
      .describe("Only errors from this task id. Comma-separate for multiple."),
    search: z.string().optional().describe("Free-text match against the error type and message."),
    period: z
      .string()
      .optional()
      .describe("Relative window for the occurrence count, e.g. 1h, 24h, 7d. Defaults to 1d."),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe("Max error groups to return (default 20)."),
  }),
});

export const getErrorSchema = tool({
  description:
    "Get the full detail for a single error group by its id (error_...): type, message, occurrence count, first/last seen, affected task versions, and lifecycle state (who resolved/ignored it and when). Pair with list_runs(errorId) to see the runs behind it.",
  inputSchema: z.object({
    errorId: z.string().describe("The error group id, e.g. error_abc123, from list_errors."),
  }),
});

// Analytics query tools (TRQL over the user's ClickHouse-backed data). Read-only.

export const getQuerySchemaSchema = tool({
  description:
    "Discover the analytics tables and columns you can query with TRQL. Call with no table to list the available tables (runs, metrics, llm_metrics, llm_models) and what each holds; call with a table name to get that table's columns, types, descriptions, and time column. Use this before writing a run_query.",
  inputSchema: z.object({
    table: z
      .string()
      .optional()
      .describe("A table name (e.g. 'runs') to get its columns. Omit to list the available tables."),
  }),
});

export const runQuerySchema = tool({
  description:
    "Run a read-only TRQL query against the current environment's analytics data and return the result rows. TRQL is a SQL-style language over ClickHouse: bucket time with toStartOfHour/toStartOfDay on the table's time column for time series, and use countIf/sumIf to produce one numeric column per series. Always call get_query_schema first. Results are capped, so keep queries aggregated. To chart the result, follow with a render_view chart block.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("The TRQL query. A read-only SELECT over runs / metrics / llm_metrics / llm_models."),
    period: z
      .string()
      .optional()
      .describe("Time window shorthand like '24h', '7d', '30d' (max 30d), applied to the table's time column."),
  }),
});

// ---------------------------------------------------------------------------
// View catalog — our own small "generative UI" layer.
//
// The agent renders rich, on-brand UI by emitting a *spec* (a stack of blocks
// drawn from a fixed catalog) via the `render_view` tool, instead of inventing
// arbitrary markup. The webapp has a render registry mapping each block `type`
// to a React component (see components/dashboard-agent/view-catalog.tsx). This
// gives us json-render's safety (only catalog blocks, validated, no arbitrary
// HTML) without its zod 4 / React 19 dependency — we stay on the pinned zod 3.
//
// `render_view`'s `execute` (in tools.ts) just validates + echoes the spec back;
// there's no API call. Add a new block by adding a member to `viewBlockSchema`
// here and a renderer entry in the webapp registry.
// ---------------------------------------------------------------------------

// The "why did this run fail?" failure card — the first (and for now only)
// catalog block. The agent gathers evidence with the read tools, then fills
// these fields. `type` is the discriminant the render registry keys off.
export const diagnosisBlockSchema = z.object({
  type: z.literal("diagnosis"),
  runId: z.string().describe("The run this diagnoses, e.g. run_abc123."),
  summary: z.string().describe("One or two plain-language sentences: what happened and why."),
  category: z
    .enum([
      "user_code_error",
      "configuration",
      "dependency",
      "timeout",
      "out_of_memory",
      "rate_limit",
      "external_service",
      "infrastructure",
      "cancellation",
      "unknown",
    ])
    .describe("Your classification of the root cause."),
  likelyCause: z
    .string()
    .describe("The most probable root cause, in specific terms — name the code, config, or dependency."),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("How confident you are in this diagnosis given the evidence. Be honest."),
  evidence: z
    .array(
      z.object({
        type: z.enum([
          "error",
          "failed_span",
          "child_run",
          "logs",
          "deploy",
          "source",
          "historical_match",
        ]),
        detail: z.string().describe("What this piece of evidence shows."),
        reference: z
          .string()
          .optional()
          .describe(
            "Optional pointer to the evidence: a run id (run_...), error id (error_...), file:line, version, or URL."
          ),
      })
    )
    .describe("The concrete signals behind the diagnosis. Cite real ids, spans, versions, or file:line."),
  impact: z
    .string()
    .optional()
    .describe("Optional: how widespread this is, e.g. how many runs hit the same error recently."),
  nextSteps: z.array(z.string()).describe("Actionable recommendations, most important first."),
  actions: z
    .array(
      z.object({
        label: z.string().describe("Button text, e.g. 'View run' or 'Read the retries docs'."),
        kind: z
          .enum(["view_run", "docs"])
          .describe("view_run links to a run page in this environment; docs opens an external URL."),
        target: z.string().describe("For view_run: a run id (run_...). For docs: an https URL."),
      })
    )
    .optional()
    .describe("Optional call-to-action buttons rendered under the card."),
});

// The chart block carries the TRQL query (not the rows): the panel runs it
// through the dashboard's own query execution + QueryResultsChart, so the chart
// is live and matches the Query page exactly. The agent describes the chart with
// the SAME config the dashboard's chart builder uses (chartType + axis columns +
// group/aggregation) and writes a query whose result columns map onto it.
export const chartBlockSchema = z.object({
  type: z.literal("chart"),
  title: z.string().optional().describe("Optional chart title."),
  query: z
    .string()
    .describe(
      "A read-only TRQL SELECT whose result columns map onto the axes below. The panel runs this query and renders the result, so write it the same way you would for run_query (toStartOfHour/toStartOfDay buckets, countIf/sumIf per series)."
    ),
  period: z
    .string()
    .optional()
    .describe("Time window shorthand like '24h', '7d', '30d' (max 30d), applied to the table's time column."),
  chartType: z
    .enum(["line", "bar"])
    .describe("line for trends over time, bar for comparing categories. Stack with `stacked` for composition."),
  xAxisColumn: z
    .string()
    .describe("The result column for the x-axis: a time bucket (for line) or a category (for bar)."),
  yAxisColumns: z
    .array(z.string())
    .min(1)
    .describe("The numeric result column(s) to plot. One per series, unless groupByColumn is set."),
  groupByColumn: z
    .string()
    .nullish()
    .describe("Optional result column to split a single yAxisColumn into one series per distinct value."),
  stacked: z.boolean().optional().describe("Stack the series (cumulative/composition). Default false."),
  aggregation: z
    .enum(["sum", "avg", "count", "min", "max"])
    .optional()
    .describe("How to combine values that share an x point. Default sum."),
});

export const viewBlockSchema = z.discriminatedUnion("type", [diagnosisBlockSchema, chartBlockSchema]);

export type DiagnosisBlock = z.infer<typeof diagnosisBlockSchema>;
export type ChartBlock = z.infer<typeof chartBlockSchema>;
export type ViewBlock = z.infer<typeof viewBlockSchema>;

export const renderViewSchema = tool({
  description:
    "Render a structured view in the dashboard panel: a stack of catalog blocks, instead of plain prose. The catalog has two blocks: `diagnosis` (the 'why did this run fail?' failure card, after gathering evidence with the read/source tools) and `chart` (a line/bar chart of run_query results). Keep any accompanying message to a one-line lead-in.",
  inputSchema: z.object({
    blocks: z.array(viewBlockSchema).min(1).describe("The blocks to render, top to bottom."),
  }),
});

// Code-mode tools (only present when the project has a connected GitHub repo).
// They read the repo's source at a pinned commit from the agent's filesystem.

// Optional run-SHA pinning: pass a run id to read the exact source that run's
// deployed version came from, instead of the latest tracked-branch commit.
const runIdField = z
  .string()
  .optional()
  .describe(
    "Optional run id (run_...) to read the exact source that run's deployed version came from, instead of the latest. Use this when investigating a specific run."
  );

export const getRepoInfoSchema = tool({
  description:
    "Get the connected GitHub repository the agent can read: owner, repo name, the commit SHA the source is pinned to, and the default branch.",
  inputSchema: z.object({ runId: runIdField }),
});

export const listFilesSchema = tool({
  description:
    "List source files in the connected repository (respecting .gitignore). Optionally filter by a glob like '**/*.ts' or scope to a subdirectory. Use this to find where something lives before reading it.",
  inputSchema: z.object({
    glob: z.string().optional().describe("Glob filter, e.g. 'src/**/*.ts' or '*.json'."),
    path: z.string().optional().describe("Subdirectory (relative to repo root) to scope the listing to."),
    runId: runIdField,
  }),
});

export const readFileSchema = tool({
  description:
    "Read a file from the connected repository by its path relative to the repo root. Optionally restrict to a line range. Use this to read the actual task source behind a run or error.",
  inputSchema: z.object({
    path: z.string().describe("File path relative to the repo root, e.g. src/trigger/processOrder.ts."),
    startLine: z.number().int().positive().optional().describe("First line to include (1-based)."),
    endLine: z.number().int().positive().optional().describe("Last line to include (1-based)."),
    runId: runIdField,
  }),
});

export const searchCodeSchema = tool({
  description:
    "Search the connected repository's source with a ripgrep query (regex or literal). Returns file:line matches. Use this to locate a task definition, an error string, a symbol, or config across the repo.",
  inputSchema: z.object({
    query: z.string().describe("The ripgrep pattern to search for."),
    glob: z.string().optional().describe("Restrict the search to files matching this glob."),
    maxResults: z.number().int().positive().max(80).optional().describe("Max matches to return (default 40)."),
    runId: runIdField,
  }),
});

/**
 * The schema-only tool set, in the same key order the agent attaches executes
 * to in `tools.ts`. Passed to `chat.headStart`'s `streamText` so step 1 can
 * emit tool calls (the agent run executes them on step 2+).
 */
export const dashboardAgentToolSchemas = {
  list_projects: listProjectsSchema,
  list_environments: listEnvironmentsSchema,
  list_tasks: listTasksSchema,
  list_runs: listRunsSchema,
  get_run: getRunSchema,
  get_run_trace: getRunTraceSchema,
  list_errors: listErrorsSchema,
  get_error: getErrorSchema,
  get_query_schema: getQuerySchemaSchema,
  run_query: runQuerySchema,
  render_view: renderViewSchema,
};

// Code mode adds the source tools. Same key order `buildDashboardAgentTools`
// attaches executes in (api tools, then repo tools), so head-start's warm step
// matches the agent run.
export const dashboardAgentCodeToolSchemas = {
  ...dashboardAgentToolSchemas,
  get_repo_info: getRepoInfoSchema,
  list_files: listFilesSchema,
  read_file: readFileSchema,
  search_code: searchCodeSchema,
};

/**
 * Default model + system prompt, single-sourced here (a light module) so both
 * the managed prompt in `prompts.ts` and the head-start route use the same
 * values without the route importing the SDK runtime. A dashboard override only
 * affects the agent run; the warm step-1 uses these defaults.
 */
// Anthropic model id used by both the warm step-1 route (via `anthropic(id)`)
// and the managed prompt default (as `anthropic:${id}`). Same model both sides
// so step 1 and step 2+ don't shift tone.
export const DASHBOARD_AGENT_MODEL = "claude-sonnet-4-6";

export const DASHBOARD_AGENT_SYSTEM_PROMPT = `You are the Trigger.dev dashboard agent, an assistant embedded in the Trigger.dev web dashboard.

Trigger.dev is a platform for writing and running reliable background tasks and AI agents in TypeScript. Users reach you from inside their dashboard while looking at runs, tasks, schedules, queues, deployments, and logs.

You have read-only tools that act as the user against their own account:
- list_projects: the projects the user can access.
- list_environments: the environments for a project (defaults to the current one).
- list_tasks: the tasks deployed in the current environment.
- list_runs: recent runs in the current environment, filterable by status, task, time period, or error group.
- get_run: status, timing, cost, and error details for a run by its run id.
- get_run_trace: a run's execution timeline (spans, durations, errors) for explaining why it failed, retried, or was slow.
- list_errors: distinct errors in the current environment grouped by fingerprint, with occurrence counts and status (unresolved/resolved/ignored).
- get_error: full detail for one error group by its error id, including affected versions and who resolved or ignored it.
- get_query_schema: discover the analytics tables and columns you can query with TRQL (runs, metrics, llm_metrics, llm_models).
- run_query: run a read-only TRQL query (SQL-style over ClickHouse) against the current environment's analytics data.
- render_view: render a structured view in the panel from the block catalog. The catalog has the "diagnosis" block (a failure card for a single run) and the "chart" block (a line/bar chart of run_query results).

Guidelines:
- Be concise and direct. A short, correct answer beats a long one.
- Prefer reading live data with your tools over guessing. When a run id, task, project, or environment is in question, look it up.
- For "what's broken" or "why is X failing" questions, start with list_errors to find the error groups, get_error for the detail, then list_runs with that error id to drill into the actual failing runs (and get_run_trace for one of them).
- Your tools are read-only and scoped to the current environment for run and task lookups. You can't change anything; for actions, point the user to where in the dashboard they can do it.
- Never invent run IDs, task identifiers, metrics, or features. If a tool returns an error or nothing, say so plainly.
- Use Trigger.dev's own terminology: tasks, runs, attempts, queues, deployments, environments, schedules, waitpoints.

Diagnosing why a run failed:
- When the user asks why a specific run failed (or to investigate a run or error), gather evidence before answering: get_run for the status and error, get_run_trace for the failing span and timeline, and get_error / list_errors to see whether it's a recurring pattern and how widespread it is.
- Then call render_view with a single "diagnosis" block holding your findings: a short summary, the failure category, the likely root cause in specific terms, your confidence, the concrete evidence (cite real run ids, error ids, span messages, and versions), the impact, the next steps, and any action buttons. This renders the failure card, so keep any accompanying message to a one-line lead-in rather than repeating the card.
- Be honest about confidence. If the evidence is thin or ambiguous, mark it low and say what's missing rather than overstating a guess.

Answering with data and charts:
- For questions about metrics, trends, counts, rates, costs, or "over time" / "by task" style aggregations, query the analytics data. First call get_query_schema (no table to list the tables, then a table name for its columns), then write a TRQL query. TRQL is SQL-style over ClickHouse: bucket time with toStartOfHour/toStartOfDay on the table's time column, produce one numeric column per series with countIf/sumIf, always include a time filter, and keep the result aggregated to a few dozen points.
- To chart the answer, call render_view with a "chart" block containing the TRQL query itself plus chartType (line for trends over time, bar for categories), xAxisColumn, yAxisColumns, and groupByColumn when you split a single value column into series. The panel runs the query and renders it, so you don't have to run_query first just to chart.
- Use run_query when you want to state specific numbers in prose, or to sanity-check a query before charting. If it returns an error, read the message and fix the query.`;

// Used when the current project has a connected GitHub repo: the base prompt
// plus the source-reading tools and how to use them.
export const DASHBOARD_AGENT_CODE_SYSTEM_PROMPT = `${DASHBOARD_AGENT_SYSTEM_PROMPT}

This project has its GitHub repository connected, so you can also read its source code:
- get_repo_info: the connected repo and the commit your source is pinned to.
- list_files: list source files (respects .gitignore), filterable by glob or subdirectory.
- read_file: read a file by its repo-relative path, optionally a line range.
- search_code: ripgrep the source for a task definition, error string, symbol, or config.

Source guidelines:
- When explaining why a run or error happened, read the actual task source rather than guessing. Find the task with search_code or list_files, then read_file the relevant code.
- When investigating a specific run, pass its run id as the runId argument to read_file/search_code/list_files. That reads the exact source the run's deployed version came from (the code that actually ran). Without runId you read the latest tracked-branch commit. Cite file paths (and line numbers when useful).
- When you render a diagnosis block for a run, read its deployed source (with the runId argument) and add a "source" evidence item whose reference is the relevant file:line, so the card points at the exact code that ran.
- Stay read-only: you can explain and point at code, but you can't edit it or open PRs.`;
