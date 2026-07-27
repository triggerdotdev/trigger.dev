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
  z.object({ kind: z.literal("error"), fingerprint: z.string() }),
  z.object({
    kind: z.literal("queue"),
    name: z.string(),
    health: z.enum(["ok", "warn", "crit"]).optional(),
  }),
  z.object({ kind: z.literal("deployment"), version: z.string() }),
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
