/** Advisory only: the agent still verifies with tools before asserting anything. */
import { runFiltersSchema } from "./run-filters.js";
import { z } from "zod";

export const agentPageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runs"), filters: runFiltersSchema.optional() }),
  z.object({
    kind: z.literal("run"),
    runId: z.string(),
    // Statuses stay plain strings throughout this union: a new status must not
    // break stored context.
    status: z.string(),
    taskId: z.string(),
    queue: z.string().optional(),
  }),
  z.object({ kind: z.literal("errors") }),
  z.object({ kind: z.literal("error"), fingerprint: z.string() }),
  z.object({ kind: z.literal("queues") }),
  z.object({
    kind: z.literal("queue"),
    name: z.string(),
    health: z.enum(["ok", "warn", "crit"]).optional(),
    /** A paused queue can neither drain nor grow, so it earns no watch and no backlog ask. */
    paused: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("deployments") }),
  z.object({
    kind: z.literal("deployment"),
    version: z.string(),
    /** `WorkerDeploymentStatus`. */
    status: z.string().optional(),
  }),
  // A detail page reuses its section's kind with an optional identity field
  // rather than adding a union member, except where it asks a different question.
  z.object({ kind: z.literal("tasks") }),
  z.object({
    kind: z.literal("task"),
    taskId: z.string(),
    /** `TaskTriggerSource` — STANDARD, SCHEDULED or AGENT. */
    triggerSource: z.string().optional(),
    queue: z.string().optional(),
    queuePaused: z.boolean().optional(),
    schedules: z.object({ total: z.number(), active: z.number() }).optional(),
  }),
  /** There is no `schedules` list kind: that listing lives on the tasks page. */
  z.object({
    kind: z.literal("schedule"),
    scheduleId: z.string(),
    taskId: z.string(),
    active: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("batches"),
    latestFailedBatchId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("batch"),
    batchId: z.string(),
    /** `BatchTaskRunStatus`. */
    status: z.string().optional(),
    failedRunCount: z.number().optional(),
  }),
  z.object({
    kind: z.literal("test"),
    taskId: z.string().optional(),
    queuePaused: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("alerts"),
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
    tokenId: z.string().optional(),
    /** `WAITING`, `COMPLETED` or `TIMED_OUT`. */
    status: z.string().optional(),
    timedOutCount: z.number().optional(),
    overdueCount: z.number().optional(),
  }),
  z.object({
    kind: z.literal("bulkactions"),
    bulkActionId: z.string().optional(),
    /** `PENDING`, `COMPLETED` or `ABORTED`. */
    status: z.string().optional(),
    failedRunCount: z.number().optional(),
    pendingCount: z.number().optional(),
  }),
  z.object({
    kind: z.literal("branches"),
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
    title: z.string().optional(),
  }),
  z.object({ kind: z.literal("agents"), agentId: z.string().optional() }),
  z.object({ kind: z.literal("playground"), agentId: z.string().optional() }),
  z.object({
    kind: z.literal("prompts"),
    slug: z.string().optional(),
    /** A version override is pinned, so runs don't use the current version. */
    overridden: z.boolean().optional(),
    overriddenCount: z.number().optional(),
  }),
  z.object({ kind: z.literal("models"), modelId: z.string().optional() }),
  z.object({
    kind: z.literal("sessions"),
    sessionId: z.string().optional(),
    runId: z.string().optional(),
    runStatus: z.string().optional(),
    expiredCount: z.number().optional(),
  }),

  /** Anything unclassified: carries the raw path. */
  z.object({ kind: z.literal("other"), path: z.string() }),
]);

export type AgentPage = z.infer<typeof agentPageSchema>;
export type AgentPageKind = AgentPage["kind"];

export const agentPageSignalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fresh_failure"), runId: z.string(), failedAt: z.string() }),
  z.object({ kind: z.literal("waiting_run"), runId: z.string(), queue: z.string().optional() }),
  z.object({
    kind: z.literal("slow_run"),
    runId: z.string(),
    durationMs: z.number().nonnegative(),
    baselineP95Ms: z.number().nonnegative(),
  }),
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
 * Every field added here must stay optional: a resumed chat replays metadata
 * stored before the field existed.
 */
export const dashboardAgentClientDataSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
  projectId: z.string().optional(),
  /** RuntimeEnvironment id: the `{env}` component of every `trigger://` URI. */
  environmentId: z.string().optional(),
  currentPage: z.string().optional(),
  pageContext: agentPageContextSchema.optional(),
});

export type DashboardAgentClientData = z.infer<typeof dashboardAgentClientDataSchema>;
