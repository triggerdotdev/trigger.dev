/**
 * Watches — the webapp half. Creation (with its guardrails), the re-authorization
 * a background check has to pass, and the chat-delete cascade.
 *
 * The one invariant everything here serves: **a watch fires with exactly the
 * access its creator had, and no more.** The org/project/environment/user snapshot
 * on the row is immutable, every check re-authorizes that snapshot against the
 * user's CURRENT access, and losing access cancels the watch rather than
 * degrading it. Nothing in this file takes a project/environment from client
 * input — callers hand in an already-authorized `AuthenticatedEnvironment`.
 */

import {
  MAX_ACTIVE_WATCHES_PER_CHAT,
  cancelActiveWatchesForChat,
  chatExists,
  createWatch,
  getChatWatchContext,
  listActiveWatchesForChats as listActiveWatchesForChatsQuery,
  markWatchDelivered,
  transitionWatchCondition,
  type ChatWatchContext,
  type PersistedWatchSpec,
  type WatchStatus,
} from "@internal/dashboard-agent-db";
import { watchIdentity, type WatchSpec } from "@internal/dashboard-agent-contracts";
import { TriggerClient } from "@trigger.dev/sdk";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { authIncludeWithParent, toAuthenticated } from "~/models/runtimeEnvironment.server";
import { isReportKey } from "~/presenters/v3/reports/report-registry";
import {
  dashboardAgentApiOrigin,
  isDashboardAgentConfigured as isDashboardAgentConfiguredDefault,
} from "~/services/dashboardAgent.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { enqueueWatchFiredAlert } from "~/services/dashboardAgentWatchAlerts.server";
import { logger } from "~/services/logger.server";
import {
  checkWatch,
  type WatchCheckDeps,
  type WatchCheckOutcome,
} from "~/services/dashboardAgentWatchChecks";
import { watchCheckDeps } from "~/services/dashboardAgentWatchChecks.server";
import { mintDashboardAgentWatchToken } from "~/services/dashboardAgentWatchToken.server";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";

/** The task that polls a watch. Lives in the agent project, triggered by us. */
export const WATCH_TASK_ID = "dashboard-agent-watch";

export { MAX_ACTIVE_WATCHES_PER_CHAT };

// ---------------------------------------------------------------------------
// Re-authorization — the gate every background check has to pass.
// ---------------------------------------------------------------------------

export type WatchAuthorization =
  | { ok: true; environment: AuthenticatedEnvironment }
  | { ok: false; reason: "access_revoked" };

/**
 * Re-authorize a watch's initiating user against the watch's IMMUTABLE
 * project/environment, through the same checks an interactive dashboard request
 * makes: org membership, a live (non-archived) environment in a live project, the
 * per-member rule for dev environments, and the dashboard-agent feature gate.
 *
 * Deliberately one query plus the feature flag — it runs on every tick.
 *
 * Anything short of a full pass is `access_revoked`: lost membership, a deleted
 * project, an archived environment, a revoked feature flag. The caller cancels the
 * watch on that answer, so a watch can only ever narrow, never widen.
 *
 * OSS caveat (VERDICTS): the self-hosted RBAC fallback ability is permissive, so
 * the membership-scoped query — not `ability.can(...)` — is the tenant floor here,
 * exactly as it is on the PAT-authenticated API routes.
 */
export async function authorizeWatchEnvironment(params: {
  userId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
}): Promise<WatchAuthorization> {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: {
      id: params.environmentId,
      // The watch's snapshot has to still describe this environment — a mismatch
      // means the row is being used to reach somewhere it was never created for.
      projectId: params.projectId,
      organizationId: params.organizationId,
      archivedAt: null,
      project: { deletedAt: null },
      organization: { deletedAt: null, members: { some: { userId: params.userId } } },
      OR: [
        { type: { in: ["PREVIEW", "STAGING", "PRODUCTION"] } },
        // Dev environments are per-member: only their owner may read them.
        { type: "DEVELOPMENT", orgMember: { userId: params.userId } },
      ],
    },
    include: authIncludeWithParent,
  });

  if (!environment) return { ok: false, reason: "access_revoked" };

  const user = await $replica.user.findFirst({
    where: { id: params.userId },
    select: { admin: true },
  });
  if (!user) return { ok: false, reason: "access_revoked" };

  const allowed = await canAccessDashboardAgent({
    userId: params.userId,
    isAdmin: user.admin,
    // A background check is never an impersonated session.
    isImpersonating: false,
    organizationSlug: environment.organization.slug,
    orgFeatureFlags: environment.organization.featureFlags as Record<string, unknown> | null,
  });
  if (!allowed) return { ok: false, reason: "access_revoked" };

  return { ok: true, environment: toAuthenticated(environment) };
}

/**
 * The same authorization, addressed by environment id alone — for the creation
 * path, where no watch row (and so no org/project snapshot to cross-check) exists
 * yet. The id lookup is unscoped on purpose and proves nothing; every membership,
 * dev-owner and feature-gate rule is applied by `authorizeWatchEnvironment` below
 * it, so an id the user can't reach still resolves to `null`.
 */
export async function authorizeWatchEnvironmentById(params: {
  userId: string;
  environmentId: string;
}): Promise<AuthenticatedEnvironment | null> {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: { id: params.environmentId },
    select: { organizationId: true, projectId: true },
  });
  if (!environment) return null;

  const authorization = await authorizeWatchEnvironment({
    userId: params.userId,
    organizationId: environment.organizationId,
    projectId: environment.projectId,
    environmentId: params.environmentId,
  });
  return authorization.ok ? authorization.environment : null;
}

// ---------------------------------------------------------------------------
// Creation.
// ---------------------------------------------------------------------------

export type CreateWatchErrorCode =
  | "limit_reached"
  | "duplicate"
  | "invalid_target"
  | "chat_not_found"
  | "not_configured"
  | "internal";

export type CreateDashboardAgentWatchResult =
  | {
      ok: true;
      watchId: string;
      identity: string;
      status: WatchStatus;
      expiresAt: Date;
      /** The creation-time check, present only when it resolved right away. */
      immediate?: WatchCheckOutcome;
    }
  | {
      ok: false;
      error: string;
      code: CreateWatchErrorCode;
      /** The watch already covering this condition, on `duplicate`. */
      existingId?: string | null;
    };

/**
 * Cheap existence check for the thing a spec points at, in THIS environment. It
 * exists so a watch can't be created against a run or queue in someone else's
 * environment (or a typo), which would then poll for its whole lifetime and
 * expire with nothing to say.
 *
 * `error_recurrence` has nothing to validate on purpose: a fingerprint with zero
 * occurrences so far is the normal case for "tell me if this comes back".
 */
async function validateWatchTarget(spec: WatchSpec, deps: WatchCheckDeps): Promise<boolean> {
  switch (spec.kind) {
    case "run_start":
    case "run_finished":
      return (await deps.readRun(spec.runId)) !== null;
    case "backlog_drain":
      return await deps.queueExists(spec.queue);
    case "error_recurrence":
      return spec.fingerprint.length > 0;
    case "health_recovery":
      return isReportKey(spec.report);
  }
}

/**
 * Create a watch for an ALREADY-AUTHORIZED context.
 *
 * The caller (a UAT endpoint or a dashboard session action) has resolved the
 * environment and proven the chat belongs to this user; this function owns
 * everything after that: target validation, the server-set `since`, the dedup
 * identity, the ≤3 guardrail (enforced in the query layer, backed by a partial
 * unique index), the token, the creation-time check, and scheduling the first tick.
 *
 * A watch is never left active-but-unwatched: if the condition is already resolved
 * at creation, or the first tick can't be scheduled, the row is resolved
 * immediately and the outcome is returned inline (already marked delivered,
 * because the caller is the one telling the user).
 */
export async function createDashboardAgentWatch(params: {
  environment: AuthenticatedEnvironment;
  userId: string;
  chatId: string;
  spec: WatchSpec;
  now?: Date;
  /** IO seams — tests inject fakes here instead of mocking the readers. */
  deps?: {
    checkDeps?: (environment: AuthenticatedEnvironment, now: Date) => WatchCheckDeps;
    scheduleTick?: typeof scheduleWatchTick;
    /** Skip the real trigger-config gate when a tick scheduler is injected. */
    configured?: () => boolean;
  };
}): Promise<CreateDashboardAgentWatchResult> {
  const { environment, userId, chatId, spec } = params;
  const now = params.now ?? new Date();
  const buildCheckDeps = params.deps?.checkDeps ?? watchCheckDeps;
  const scheduleTick = params.deps?.scheduleTick ?? scheduleWatchTick;
  const isDashboardAgentConfigured = params.deps?.configured ?? isDashboardAgentConfiguredDefault;
  const checkDeps = buildCheckDeps(environment, now);

  if (!isDashboardAgentConfigured()) {
    return {
      ok: false,
      code: "not_configured",
      error: "The dashboard agent is not configured, so watches can't be scheduled.",
    };
  }

  if (!(await validateWatchTarget(spec, checkDeps))) {
    return {
      ok: false,
      code: "invalid_target",
      error: "That target doesn't exist in this environment.",
    };
  }

  // `since` is SERVER-SET so the model can't backdate a recurrence window and
  // make a pre-existing error look like a recurrence.
  const persistedSpec: PersistedWatchSpec =
    spec.kind === "error_recurrence" ? { ...spec, since: now.toISOString() } : spec;

  const identity = watchIdentity(spec);
  const expiresAt = new Date(now.getTime() + spec.maxHours * 60 * 60 * 1000);

  const created = await createWatch(dashboardAgentDb, {
    chatId,
    identity,
    spec: persistedSpec,
    organizationId: environment.organizationId,
    projectId: environment.projectId,
    environmentId: environment.id,
    userId,
    expiresAt,
  });

  if (!created.ok) {
    if (created.error === "limit_reached") {
      return {
        ok: false,
        code: "limit_reached",
        error: `This chat already has ${MAX_ACTIVE_WATCHES_PER_CHAT} active watches. Cancel one first.`,
      };
    }
    return {
      ok: false,
      code: "duplicate",
      error: "This chat is already watching that.",
      existingId: created.existingId,
    };
  }

  const watch = created.watch;
  const token = await mintDashboardAgentWatchToken({ watchId: watch.id, expiresAt });

  // The creation-time check: many watches are asked for after the condition has
  // already happened, and answering in the same turn beats waiting a cadence.
  const immediate = await checkWatch(persistedSpec, checkDeps, { now, since: now }, (error) =>
    logger.error("Dashboard agent watch: immediate check failed", { id: watch.id, error })
  );

  if (immediate.result === "satisfied" || immediate.result === "terminal_unsatisfied") {
    const status = immediate.result === "satisfied" ? "fired" : "expired";
    const resolved = await resolveWatchInline(watch.id, status, immediate);
    return {
      ok: true,
      watchId: watch.id,
      identity,
      status: resolved,
      expiresAt,
      immediate,
    };
  }

  try {
    await scheduleTick({
      watchId: watch.id,
      token,
      delayMinutes: spec.checkEveryMinutes,
      // The key is indexed by the row's CURRENT tickCount (0 here), which is the
      // same scheme the watcher task reschedules with (`tickCount + 1` of the row
      // it read). Off-by-one here would collide with the task's first reschedule
      // and silently break the chain.
      tick: watch.tickCount,
    });
  } catch (error) {
    logger.error("Dashboard agent watch: failed to schedule the first tick", {
      id: watch.id,
      error,
    });
    // Nothing will ever check this watch, so don't leave it sitting active and
    // silently blocking a re-ask: end the row and report a plain failure. NOT an
    // `immediate` outcome — that means "the condition already resolved", and
    // saying so here would have the agent narrate a verdict nobody measured.
    await resolveWatchInline(watch.id, "expired", {
      result: "unavailable",
      facts: { kind: spec.kind, reason: "scheduling_failed" },
    });
    return {
      ok: false,
      code: "internal",
      error: "The watch couldn't be scheduled. Nothing is being watched.",
    };
  }

  return { ok: true, watchId: watch.id, identity, status: "active", expiresAt };
}

/**
 * Resolve a watch whose outcome is being reported in the SAME response that
 * created it. Marked delivered because the caller is the notification — the
 * watcher task must never narrate it a second time.
 */
async function resolveWatchInline(
  watchId: string,
  status: "fired" | "expired",
  outcome: WatchCheckOutcome
): Promise<WatchStatus> {
  const transitioned = await transitionWatchCondition(dashboardAgentDb, {
    id: watchId,
    status,
    lastResult: { result: outcome.result, facts: outcome.facts },
  });
  if (!transitioned) return status;
  await markWatchDelivered(dashboardAgentDb, { id: watchId });

  // The chat is being told inline; the configured alert channels still need the
  // fan-out. Keyed on the watch, so the watcher task can't double-alert it.
  try {
    await enqueueWatchFiredAlert(transitioned, status);
  } catch (error) {
    logger.error("Dashboard agent watch: failed to enqueue the fired alert", {
      id: watchId,
      error,
    });
  }

  return transitioned.status;
}

/**
 * Trigger one tick of the watcher task in the agent's project, as the agent's own
 * environment (`DASHBOARD_AGENT_SECRET_KEY`) — the same credential and version
 * pinning `dashboardAgent.server.ts` uses for the agent itself.
 *
 * The token travels in the payload rather than the database: it's a pure function
 * of `(SESSION_SECRET, watchId, expiresAt)`, so a re-schedule can always re-mint
 * an identical one (see `dashboardAgentWatchToken.server.ts`).
 */
export async function scheduleWatchTick(params: {
  watchId: string;
  token: string;
  delayMinutes: number;
  tick: number;
}): Promise<void> {
  const accessToken = env.DASHBOARD_AGENT_SECRET_KEY;
  if (!accessToken) throw new Error("DASHBOARD_AGENT_SECRET_KEY is not set");

  const apiOrigin = dashboardAgentApiOrigin();
  const client = new TriggerClient({ baseURL: apiOrigin, accessToken });

  await client.tasks.trigger(
    WATCH_TASK_ID,
    // The watcher task's payload contract: the watch, its token, and the origin
    // to call the check endpoint on.
    { watchId: params.watchId, token: params.token, apiOrigin },
    {
      delay: `${params.delayMinutes}m`,
      // Same key shape the query layer documents, so a retried schedule can't
      // double-tick.
      idempotencyKey: `watch:${params.watchId}:tick:${params.tick}`,
      // Pin to the same deployed agent version the chat runs on, when set.
      ...(env.DASHBOARD_AGENT_VERSION ? { version: env.DASHBOARD_AGENT_VERSION } : {}),
    }
  );
}

// ---------------------------------------------------------------------------
// Chat lifecycle + the list view.
// ---------------------------------------------------------------------------

/**
 * Deleting a chat ends its watches: the conversation they'd wake is gone, so
 * there's nowhere to deliver an outcome. Ownership must be verified by the caller
 * (this is keyed on chatId alone, like the query layer's cascade).
 */
export async function cancelWatchesForDeletedChat(chatId: string): Promise<number> {
  const cancelled = await cancelActiveWatchesForChat(dashboardAgentDb, {
    chatId,
    reason: "chat_deleted",
  });
  return cancelled.length;
}

/**
 * What the panel needs to show a chat's watch chips. The dates are strings
 * because this crosses a loader's JSON boundary.
 */
export type ChatWatchChip = {
  id: string;
  identity: string;
  status: WatchStatus;
  kind: string;
  note: string;
  checkEveryMinutes: number;
  expiresAt: string;
};

/**
 * Active watches for many chats in ONE query, keyed by chatId — the panel and
 * history list must not fan out a query per chat. The query layer re-scopes the
 * chat ids by org + user, so this is safe with ids from any source.
 */
export async function listActiveWatchesForChats(params: {
  chatIds: string[];
  organizationId: string;
  userId: string;
}): Promise<Record<string, ChatWatchChip[]>> {
  const byChat = await listActiveWatchesForChatsQuery(dashboardAgentDb, params);

  return Object.fromEntries(
    Object.entries(byChat).map(([chatId, watches]) => [
      chatId,
      watches.map((watch) => ({
        id: watch.id,
        identity: watch.identity,
        status: watch.status,
        kind: watch.kind,
        note: watch.note,
        checkEveryMinutes: watch.checkEveryMinutes,
        expiresAt: watch.expiresAt.toISOString(),
      })),
    ])
  );
}

/** Owner check for a chat, for the adapters. */
export function chatBelongsToUser(params: {
  chatId: string;
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  return chatExists(dashboardAgentDb, params);
}

export type { ChatWatchContext };

/**
 * Ownership check AND context read in one query — a live chat owned by this user,
 * plus the project/environment its turns ran in. See `getChatWatchContext` for why
 * the context is a claim and not an authorization.
 */
export function resolveChatWatchContext(params: {
  chatId: string;
  userId: string;
}): Promise<ChatWatchContext | null> {
  return getChatWatchContext(dashboardAgentDb, params);
}
