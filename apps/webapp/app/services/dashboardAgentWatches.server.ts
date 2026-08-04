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
  cancelWatch,
  chatExists,
  createWatch,
  getChatWatchContext,
  listActiveWatchesForChats as listActiveWatchesForChatsQuery,
  precheckWatchCreation,
  softDeleteChat,
  type ChatWatchContext,
  type PersistedWatchSpec,
  type WatchStatus,
} from "@internal/dashboard-agent-db";
import {
  watchIdentity,
  type WatchObservedOutcome,
  type WatchResolution,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import { TriggerClient } from "@trigger.dev/sdk";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { authIncludeWithParent, toAuthenticated } from "~/models/runtimeEnvironment.server";
import { isReportKey } from "~/presenters/v3/reports/report-registry";
import {
  dashboardAgentApiOrigin,
  isDashboardAgentConfigured as isDashboardAgentConfiguredDefault,
} from "~/services/dashboardAgent.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
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
  // The PRIMARY, not the replica: this is the authorization boundary every
  // background tick passes through, and replica lag would extend access the user
  // has already lost.
  const environment = await prisma.runtimeEnvironment.findFirst({
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

  // Primary for the same reason as the membership read above: this decides
  // access for a background tick, and lag must not extend it.
  const user = await prisma.user.findFirst({
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

/**
 * What creation answered with.
 *
 * Two shapes, because the resolution model gives the immediate check its own
 * ending: either a watch is now running (`watching: true`), or the check already
 * answered the request and **no watch row exists at all** (`watching: false`).
 * The second one is the ONE-SHOT RESULT BLOCK of §2.2/§4.1 — it never enters the
 * watch delivery state machine: no row, no claim, no chip, no wake.
 */
export type CreateDashboardAgentWatchResult =
  | {
      ok: true;
      watching: true;
      watchId: string;
      identity: string;
      status: WatchStatus;
      expiresAt: Date;
      /**
       * Set when the creation-time check couldn't run. The watch is active
       * anyway; the confirmation says "We couldn't check that just now."
       */
      unavailable?: boolean;
    }
  | {
      ok: true;
      watching: false;
      identity: string;
      /** `satisfied` (already true) or `terminal_unsatisfied` (can't happen now). */
      immediate: WatchCheckOutcome;
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
    case "run_failed":
      return (await deps.readRun(spec.runId)) !== null;
    case "backlog_drain":
    case "queue_depth_above":
    case "queue_depth_below":
    case "queue_stalled":
    case "queue_oldest_age":
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
 * everything after that.
 *
 * The order is §4.4's, and it is load-bearing: **cap → dedup → immediate check →
 * create**. The guardrails are consulted first, so "you already have three" and
 * "you're already watching this" are answered the same way whether or not the
 * condition happens to be true right now. Then the immediate check runs, and:
 *
 *   - `satisfied` / `terminal_unsatisfied` → **no row is written**. The check
 *     answered the request; the caller renders a one-shot result block and the
 *     agent answers from it. There is no chip, no wake, and nothing to cancel.
 *   - `pending` / `unavailable` → the watch is created and the first tick
 *     scheduled. `unavailable` is not a verdict, so it never resolves anything —
 *     the confirmation just says we couldn't check yet.
 *
 * A watch is never left active-but-unwatched: if the first tick can't be
 * scheduled, the row is CANCELLED (silent, no resolution, no wake — a scheduling
 * failure is not an answer about the user's condition) and a plain failure is
 * returned.
 */
export async function createDashboardAgentWatch(params: {
  environment: AuthenticatedEnvironment;
  userId: string;
  chatId: string;
  spec: WatchSpec;
  /**
   * Consent to investigate after an attention outcome (§6). Only ever true when
   * the user asked for it at creation — it is never inferred here, and it is not
   * part of the spec or the identity.
   */
  investigateOnAttention?: boolean;
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

  const identity = watchIdentity(spec);

  // The guardrails, before the check and before any write. Advisory (a plain
  // read); `createWatch` below re-applies both atomically and stays the authority.
  const precheck = await precheckWatchCreation(dashboardAgentDb, {
    chatId,
    projectId: environment.projectId,
    environmentId: environment.id,
    identity,
  });
  if (!precheck.ok) return creationGuardrailError(precheck);

  // `since` is SERVER-SET so the model can't backdate a recurrence window and
  // make a pre-existing error look like a recurrence.
  const persistedSpec: PersistedWatchSpec =
    spec.kind === "error_recurrence" ? { ...spec, since: now.toISOString() } : spec;

  // The creation-time check. Many watches are asked for after the condition has
  // already happened, and answering in the same turn beats waiting a cadence —
  // and under the resolution model that answer needs no watch at all.
  const immediate = await checkWatch(persistedSpec, checkDeps, { now, since: now }, (error) =>
    logger.error("Dashboard agent watch: immediate check failed", { chatId, identity, error })
  );

  if (immediate.result === "satisfied" || immediate.result === "terminal_unsatisfied") {
    // The one-shot result block. Nothing is persisted here on purpose: no row
    // means no chip, no delivery claim, and no wake that could tell the user a
    // second time (§7.5).
    return { ok: true, watching: false, identity, immediate };
  }

  const expiresAt = new Date(now.getTime() + spec.maxHours * 60 * 60 * 1000);

  const created = await createWatch(dashboardAgentDb, {
    chatId,
    identity,
    spec: persistedSpec,
    organizationId: environment.organizationId,
    projectId: environment.projectId,
    // The external ref travels with the row so a wake can scope an investigation
    // the same way a turn does — the agent can't translate the internal id.
    projectRef: environment.project.externalRef,
    environmentId: environment.id,
    userId,
    expiresAt,
    investigateOnAttention: params.investigateOnAttention === true,
  });

  if (!created.ok) {
    if (created.error === "chat_not_found") {
      // The chat was deleted while this create was in flight — the query layer
      // re-reads it under the per-chat lock, so nothing was written.
      return {
        ok: false,
        code: "chat_not_found",
        error: "That chat no longer exists, so nothing is being watched.",
      };
    }
    return creationGuardrailError(created);
  }

  const watch = created.watch;
  const token = await mintDashboardAgentWatchToken({ watchId: watch.id, expiresAt });

  try {
    await scheduleTick({
      watchId: watch.id,
      token,
      delayMinutes: spec.checkEveryMinutes,
      // The GENERATION the first tick will claim: the row is on `tickCount`
      // (0 here) and each invocation claims its own generation atomically, so the
      // first one is `tickCount + 1`.
      tick: watch.tickCount + 1,
    });
  } catch (error) {
    logger.error("Dashboard agent watch: failed to schedule the first tick", {
      id: watch.id,
      error,
    });
    // Nothing will ever check this watch, so don't leave it sitting active and
    // silently blocking a re-ask. CANCELLED, not resolved: the user's condition
    // was never evaluated, and a resolution would have the agent narrate a verdict
    // nobody measured. Cancellation is silent, so no wake is ever sent.
    await cancelWatch(dashboardAgentDb, { id: watch.id, reason: "scheduling_failed" });
    return {
      ok: false,
      code: "internal",
      error: "The watch couldn't be scheduled. Nothing is being watched.",
    };
  }

  return {
    ok: true,
    watching: true,
    watchId: watch.id,
    identity,
    status: "active",
    expiresAt,
    ...(immediate.result === "unavailable" ? { unavailable: true } : {}),
  };
}

/** The two guardrail refusals, worded once for both the pre-check and the insert. */
function creationGuardrailError(
  refusal:
    | { error: "limit_reached"; activeCount: number }
    | { error: "duplicate"; existingId: string | null }
): CreateDashboardAgentWatchResult {
  if (refusal.error === "limit_reached") {
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
    existingId: refusal.existingId,
  };
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
  /** The tick generation the scheduled invocation claims. */
  tick: number;
}): Promise<void> {
  const accessToken = env.DASHBOARD_AGENT_SECRET_KEY;
  if (!accessToken) throw new Error("DASHBOARD_AGENT_SECRET_KEY is not set");

  const apiOrigin = dashboardAgentApiOrigin();
  const client = new TriggerClient({ baseURL: apiOrigin, accessToken });

  await client.tasks.trigger(
    WATCH_TASK_ID,
    // The watcher task's payload contract: the watch, its token, the origin to
    // call the check endpoint on, and the tick generation this invocation owns.
    { watchId: params.watchId, token: params.token, apiOrigin, tick: params.tick },
    {
      delay: `${params.delayMinutes}m`,
      // Keyed on the same generation the payload carries, so a retried schedule
      // can't double-tick.
      idempotencyKey: `watch:${params.watchId}:tick:${params.tick}`,
      // Pin to the same deployed agent version the chat runs on, when set.
      ...(env.DASHBOARD_AGENT_VERSION ? { version: env.DASHBOARD_AGENT_VERSION } : {}),
    }
  );
}

/**
 * Hand a RESOLVED watch's wake to the watcher task.
 *
 * The webapp decides outcomes (it owns the authorization and the check), the agent
 * project owns appending to a chat's `in` stream — so a wake the webapp resolved is
 * delivered by a delivery-only invocation of the same task a tick uses. It takes
 * the same durable path: append, then mark the delivery, with the stable action id
 * doing the dedup if it runs twice.
 *
 * Keyed per watch (`watch:{id}:deliver`) with a short TTL, so repeated sweeps
 * inside one window collapse into one invocation while a later sweep can still try
 * again after a run failed for good.
 *
 * The token is the row's own deterministic one. Past the watch's grace window it is
 * expired, which costs nothing here: a delivery-only invocation never calls the
 * check endpoint, and the alert fan-out is enqueued by the caller.
 */
export async function scheduleWatchDelivery(watch: { id: string; expiresAt: Date }): Promise<void> {
  const accessToken = env.DASHBOARD_AGENT_SECRET_KEY;
  if (!accessToken) throw new Error("DASHBOARD_AGENT_SECRET_KEY is not set");

  const apiOrigin = dashboardAgentApiOrigin();
  const client = new TriggerClient({ baseURL: apiOrigin, accessToken });
  const token = await mintDashboardAgentWatchToken({
    watchId: watch.id,
    expiresAt: watch.expiresAt,
  });

  await client.tasks.trigger(
    WATCH_TASK_ID,
    { watchId: watch.id, token, apiOrigin, tick: 0, deliverOnly: true },
    {
      idempotencyKey: `watch:${watch.id}:deliver`,
      idempotencyKeyTTL: "10m",
      ...(env.DASHBOARD_AGENT_VERSION ? { version: env.DASHBOARD_AGENT_VERSION } : {}),
    }
  );
}

// ---------------------------------------------------------------------------
// Chat lifecycle + the list view.
// ---------------------------------------------------------------------------

/**
 * Delete a chat and end its watches in ONE transaction: the conversation they'd
 * wake is gone, so there's nowhere to deliver an outcome, and a half-applied
 * delete would leave live watches on a chat the user can't see. Owner-scoped, so
 * a chatId the caller doesn't own deletes nothing.
 */
export async function deleteChatWithWatches(params: {
  chatId: string;
  userId: string;
}): Promise<{ deleted: boolean; cancelledWatches: number }> {
  const result = await softDeleteChat(dashboardAgentDb, params);
  return { deleted: result.deleted, cancelledWatches: result.cancelledWatches.length };
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
  endedReason: string | null;
  /** How the watch ended — what the wake banner presents. Null while active. */
  resolution: WatchResolution | null;
  /** What the resolving check observed — the other half of the headline. */
  observedOutcome: WatchObservedOutcome | null;
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
        endedReason: watch.endedReason,
        resolution: watch.resolution,
        observedOutcome: watch.observedOutcome,
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
 * Ownership check for a chat — a live chat owned by this user — plus the org it
 * belongs to, which is the tenancy floor its watches can't leave. Deliberately no
 * project/environment: those come from the authorized request context, never from
 * the chat row (see `getChatWatchContext`).
 */
export function resolveChatWatchContext(params: {
  chatId: string;
  userId: string;
}): Promise<ChatWatchContext | null> {
  return getChatWatchContext(dashboardAgentDb, params);
}
