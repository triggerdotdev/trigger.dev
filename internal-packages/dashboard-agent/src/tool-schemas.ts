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
    "List recent runs in the current environment, newest first. Optionally filter by status, task, or time period. Use this for 'what's been running', 'recent failures', etc.",
  inputSchema: z.object({
    status: z
      .string()
      .optional()
      .describe("Run status filter, e.g. COMPLETED, FAILED, EXECUTING, QUEUED, CANCELED."),
    taskIdentifier: z.string().optional().describe("Only runs of this task id."),
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
- list_runs: recent runs in the current environment, filterable by status, task, or time period.
- get_run: status, timing, cost, and error details for a run by its run id.
- get_run_trace: a run's execution timeline (spans, durations, errors) for explaining why it failed, retried, or was slow.

Guidelines:
- Be concise and direct. A short, correct answer beats a long one.
- Prefer reading live data with your tools over guessing. When a run id, task, project, or environment is in question, look it up.
- Your tools are read-only and scoped to the current environment for run and task lookups. You can't change anything; for actions, point the user to where in the dashboard they can do it.
- Never invent run IDs, task identifiers, metrics, or features. If a tool returns an error or nothing, say so plainly.
- Use Trigger.dev's own terminology: tasks, runs, attempts, queues, deployments, environments, schedules, waitpoints.`;
