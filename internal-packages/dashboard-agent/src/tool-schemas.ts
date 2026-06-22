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

// Code-mode tools (only present when the project has a connected GitHub repo).
// They read the repo's source at a pinned commit from the agent's filesystem.

export const getRepoInfoSchema = tool({
  description:
    "Get the connected GitHub repository the agent can read: owner, repo name, the commit SHA the source is pinned to, and the default branch.",
  inputSchema: z.object({}),
});

export const listFilesSchema = tool({
  description:
    "List source files in the connected repository (respecting .gitignore). Optionally filter by a glob like '**/*.ts' or scope to a subdirectory. Use this to find where something lives before reading it.",
  inputSchema: z.object({
    glob: z.string().optional().describe("Glob filter, e.g. 'src/**/*.ts' or '*.json'."),
    path: z.string().optional().describe("Subdirectory (relative to repo root) to scope the listing to."),
  }),
});

export const readFileSchema = tool({
  description:
    "Read a file from the connected repository by its path relative to the repo root. Optionally restrict to a line range. Use this to read the actual task source behind a run or error.",
  inputSchema: z.object({
    path: z.string().describe("File path relative to the repo root, e.g. src/trigger/processOrder.ts."),
    startLine: z.number().int().positive().optional().describe("First line to include (1-based)."),
    endLine: z.number().int().positive().optional().describe("Last line to include (1-based)."),
  }),
});

export const searchCodeSchema = tool({
  description:
    "Search the connected repository's source with a ripgrep query (regex or literal). Returns file:line matches. Use this to locate a task definition, an error string, a symbol, or config across the repo.",
  inputSchema: z.object({
    query: z.string().describe("The ripgrep pattern to search for."),
    glob: z.string().optional().describe("Restrict the search to files matching this glob."),
    maxResults: z.number().int().positive().max(80).optional().describe("Max matches to return (default 40)."),
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

Guidelines:
- Be concise and direct. A short, correct answer beats a long one.
- Prefer reading live data with your tools over guessing. When a run id, task, project, or environment is in question, look it up.
- For "what's broken" or "why is X failing" questions, start with list_errors to find the error groups, get_error for the detail, then list_runs with that error id to drill into the actual failing runs (and get_run_trace for one of them).
- Your tools are read-only and scoped to the current environment for run and task lookups. You can't change anything; for actions, point the user to where in the dashboard they can do it.
- Never invent run IDs, task identifiers, metrics, or features. If a tool returns an error or nothing, say so plainly.
- Use Trigger.dev's own terminology: tasks, runs, attempts, queues, deployments, environments, schedules, waitpoints.`;

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
- The source you read is pinned to the commit the run was deployed from, so it is the code that actually ran. Cite file paths (and line numbers when useful).
- Stay read-only: you can explain and point at code, but you can't edit it or open PRs.`;
