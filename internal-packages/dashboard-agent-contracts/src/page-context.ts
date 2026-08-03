/**
 * Page context — what the user is looking at when they open the panel, plus the
 * notable things the host already knows about that page.
 *
 * `page` is the *what*: a coarse classification of the route with just enough
 * identity to act on. `signals` are the *why now*: pre-computed observations the
 * host derived from the page's own data, so the agent doesn't have to re-query to
 * notice the obvious. Both are advisory — the agent still verifies with tools
 * before asserting anything.
 */
import { runFiltersSchema } from "./run-filters.js";
import { z } from "zod";

export const agentPageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runs"), filters: runFiltersSchema.optional() }),
  z.object({
    kind: z.literal("run"),
    runId: z.string(),
    /** Run status as the dashboard displays it. Plain string: a new status must not break stored context. */
    status: z.string(),
    taskId: z.string(),
    queue: z.string().optional(),
  }),
  /** The errors list. Plural kinds are lists, singular kinds are one thing. */
  z.object({ kind: z.literal("errors") }),
  z.object({ kind: z.literal("error"), fingerprint: z.string() }),
  z.object({ kind: z.literal("queues") }),
  z.object({
    kind: z.literal("queue"),
    name: z.string(),
    health: z.enum(["ok", "warn", "crit"]).optional(),
  }),
  z.object({ kind: z.literal("deployments") }),
  z.object({
    kind: z.literal("deployment"),
    version: z.string(),
    /** `WorkerDeploymentStatus`. Plain string: a new status must not break stored context. */
    status: z.string().optional(),
  }),
  // -------------------------------------------------------------------------
  // The rest of the environment's sections.
  //
  // A singular kind exists only where the detail page asks a DIFFERENT question
  // than its list (`task` vs `tasks`, `batch` vs `batches`). Where the detail
  // page asks the same question about one named thing, it reuses the section's
  // kind with an optional identity field instead of doubling the union —
  // `{ kind: "sessions", sessionId }` is the session detail page.
  //
  // Every field beyond `kind` is optional and comes from data the page's loader
  // already returned. A field that isn't in the loader is simply absent.
  // -------------------------------------------------------------------------

  /** The tasks list, and the tasks activity dashboard. */
  z.object({ kind: z.literal("tasks") }),
  z.object({
    kind: z.literal("task"),
    taskId: z.string(),
    /** `TaskTriggerSource` — STANDARD, SCHEDULED or AGENT. Plain string by convention. */
    triggerSource: z.string().optional(),
    /** The queue this task runs on, when it has one of its own. */
    queue: z.string().optional(),
    /** The queue is paused, so nothing on it will start. */
    queuePaused: z.boolean().optional(),
    /** Schedule counts, for a scheduled task: none attached, or none enabled, means it never runs. */
    schedules: z.object({ total: z.number(), active: z.number() }).optional(),
  }),
  /**
   * One schedule. There is no `schedules` list kind: the standalone listing was
   * folded into the tasks page, which reports as `tasks`.
   */
  z.object({
    kind: z.literal("schedule"),
    scheduleId: z.string(),
    taskId: z.string(),
    /** Disabled schedules don't fire. */
    active: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("batches"),
    /** The newest batch on an unfiltered list, when that batch didn't come out clean. */
    latestFailedBatchId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("batch"),
    batchId: z.string(),
    /** `BatchTaskRunStatus`. Plain string: a new status must not break stored context. */
    status: z.string().optional(),
    failedRunCount: z.number().optional(),
  }),
  /** The test page, with the task being tested when one is selected. */
  z.object({
    kind: z.literal("test"),
    taskId: z.string().optional(),
    queuePaused: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("alerts"),
    /** Channels configured for this environment, and how many are switched off. */
    channelCount: z.number().optional(),
    disabledChannelCount: z.number().optional(),
  }),
  z.object({ kind: z.literal("apikeys") }),
  z.object({ kind: z.literal("envvars") }),
  z.object({ kind: z.literal("concurrency") }),
  z.object({ kind: z.literal("regions") }),
  z.object({ kind: z.literal("settings") }),
  z.object({
    kind: z.literal("waitpoints"),
    /** One token, on the token detail page. */
    tokenId: z.string().optional(),
    /** `WAITING`, `COMPLETED` or `TIMED_OUT`, for a single token. */
    status: z.string().optional(),
    /** List counts: tokens that timed out, and tokens still waiting past their timeout. */
    timedOutCount: z.number().optional(),
    overdueCount: z.number().optional(),
  }),
  z.object({
    kind: z.literal("bulkactions"),
    bulkActionId: z.string().optional(),
    /** `PENDING`, `COMPLETED` or `ABORTED`. */
    status: z.string().optional(),
    failedRunCount: z.number().optional(),
    /** List count: actions still in flight. */
    pendingCount: z.number().optional(),
  }),
  z.object({
    kind: z.literal("branches"),
    /** No more branches can be created on this plan. */
    atLimit: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("logs") }),
  z.object({
    kind: z.literal("limits"),
    /** Names of the quotas already at or over their limit. */
    exhausted: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal("query") }),
  z.object({
    kind: z.literal("dashboards"),
    /** The dashboard's own title, when the user is on one rather than the chooser. */
    title: z.string().optional(),
  }),
  z.object({ kind: z.literal("agents"), agentId: z.string().optional() }),
  z.object({ kind: z.literal("playground"), agentId: z.string().optional() }),
  z.object({
    kind: z.literal("prompts"),
    slug: z.string().optional(),
    /** A version override is pinned, so runs don't use the current version. */
    overridden: z.boolean().optional(),
    /** List count: prompts with an override pinned. */
    overriddenCount: z.number().optional(),
  }),
  z.object({ kind: z.literal("models"), modelId: z.string().optional() }),
  z.object({
    kind: z.literal("sessions"),
    sessionId: z.string().optional(),
    /** The session's current run and how it ended, on the session detail page. */
    runId: z.string().optional(),
    runStatus: z.string().optional(),
    /** List count: sessions that expired instead of closing. */
    expiredCount: z.number().optional(),
  }),

  /** Anywhere we haven't classified: carry the raw path so the agent isn't blind. */
  z.object({ kind: z.literal("other"), path: z.string() }),
]);

export type AgentPage = z.infer<typeof agentPageSchema>;
export type AgentPageKind = AgentPage["kind"];

export const agentPageSignalSchema = z.discriminatedUnion("kind", [
  /** A run on this page failed recently enough to be the reason the user is here. */
  z.object({ kind: z.literal("fresh_failure"), runId: z.string(), failedAt: z.string() }),
  /** A run is sitting in the queue rather than executing. */
  z.object({ kind: z.literal("waiting_run"), runId: z.string(), queue: z.string().optional() }),
  /** A run is running well past its task's usual duration. */
  z.object({
    kind: z.literal("slow_run"),
    runId: z.string(),
    durationMs: z.number().nonnegative(),
    baselineP95Ms: z.number().nonnegative(),
  }),
  /** Concurrency is pinned, so work is queueing behind the limit. */
  z.object({ kind: z.literal("concurrency_saturation"), severity: z.enum(["warn", "crit"]) }),
]);

export type AgentPageSignal = z.infer<typeof agentPageSignalSchema>;
export type AgentPageSignalKind = AgentPageSignal["kind"];

export const agentPageContextSchema = z.object({
  page: agentPageSchema,
  signals: z.array(agentPageSignalSchema),
});

export type AgentPageContext = z.infer<typeof agentPageContextSchema>;

/**
 * The per-turn client data the webapp sends with a chat turn.
 *
 * This is a strict SUPERSET of the webapp's local `DashboardAgentClientData`
 * (apps/webapp/app/components/dashboard-agent/DashboardAgentChat.tsx): the
 * existing fields keep their exact shape and every field added here is OPTIONAL,
 * because a resumed chat replays metadata that was stored before these fields
 * existed. Never make a field here required.
 */
export const dashboardAgentClientDataSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
  projectId: z.string().optional(),
  /**
   * RuntimeEnvironment id — the `{env}` component of every `trigger://` URI the
   * turn produces.
   */
  environmentId: z.string().optional(),
  /** Human-readable current page path, as sent today. */
  currentPage: z.string().optional(),
  /** Structured view of the same page, when the host can classify it. */
  pageContext: agentPageContextSchema.optional(),
});

export type DashboardAgentClientData = z.infer<typeof dashboardAgentClientDataSchema>;
