/**
 * Watches, webapp half: creation, the re-authorization a background check passes, and the
 * chat-delete cascade. The row's snapshot is immutable, and no target comes from client input.
 */

import {
  MAX_ACTIVE_WATCHES_PER_CHAT,
  appendChatMessageOnce,
  armWatchBatch,
  cancelWatch,
  chatExists,
  createChat,
  createWatch,
  getChatWatchContext,
  getWatch,
  listActiveWatchesForChats as listActiveWatchesForChatsQuery,
  precheckWatchCreation,
  softDeleteChat,
  stopWatchBatch,
  type ChatWatchContext,
  type PersistedWatchSpec,
  type Watch,
  type WatchStatus,
} from "@internal/dashboard-agent-db";
import {
  VIEW_BLOCK_VERSION,
  WATCH_CONFIRMATION_MESSAGE_ID_PREFIX,
  WATCH_REQUEST_MESSAGE_ID_PREFIX,
  watchConfirmationBlockBody,
  watchIdentity,
  watchOneShotBlockBody,
  watchRequestSentence,
  watchSubjectLabel,
  type WatchDraft,
  type WatchObservedOutcome,
  type WatchResolution,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import { createHash } from "node:crypto";
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
import { watchCreationCheckDeps } from "~/services/dashboardAgentWatchChecks.server";
import { subscribeUserToWatchAlerts } from "~/services/dashboardAgentWatchAlerts.server";
import {
  mintDashboardAgentWatchBatchToken,
  mintDashboardAgentWatchToken,
} from "~/services/dashboardAgentWatchToken.server";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";

/** The task that polls a watch. Lives in the agent project, triggered by us. */
export const WATCH_TASK_ID = "dashboard-agent-watch";

export { MAX_ACTIVE_WATCHES_PER_CHAT };

export type WatchAuthorization =
  | { ok: true; environment: AuthenticatedEnvironment }
  | { ok: false; reason: "access_revoked" };

/**
 * Re-authorize a watch's initiating user against the row's immutable project/environment; a
 * partial pass is `access_revoked`. The membership-scoped query is the tenant floor here.
 */
export async function authorizeWatchEnvironment(params: {
  userId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
}): Promise<WatchAuthorization> {
  // The primary, not the replica: replica lag would extend access the user has lost.
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: params.environmentId,
      // The watch's snapshot has to still describe this environment.
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

  // The gate only reads `isAdmin` while the admin preview is on, so this read is skipped
  // otherwise: it runs on every watch check, batch authorization and sweep finalisation.
  let isAdmin = false;
  if (env.DASHBOARD_AGENT_ADMIN_PREVIEW === "1") {
    // Primary for the same reason as the membership read above.
    const user = await prisma.user.findFirst({
      where: { id: params.userId },
      select: { admin: true },
    });
    if (!user) return { ok: false, reason: "access_revoked" };
    isAdmin = user.admin;
  }

  const allowed = await canAccessDashboardAgent({
    userId: params.userId,
    isAdmin,
    // A background check is never an impersonated session.
    isImpersonating: false,
    organizationSlug: environment.organization.slug,
    orgFeatureFlags: environment.organization.featureFlags as Record<string, unknown> | null,
  });
  if (!allowed) return { ok: false, reason: "access_revoked" };

  return { ok: true, environment: toAuthenticated(environment) };
}

/**
 * The same authorization by environment id alone, for the creation path with no watch row
 * yet. The id lookup is unscoped and proves nothing; `authorizeWatchEnvironment` is the gate.
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

export type CreateWatchErrorCode =
  | "limit_reached"
  | "duplicate"
  | "invalid_target"
  | "chat_not_found"
  | "not_configured"
  | "internal";

/**
 * Either a watch is now running (`watching: true`), or the immediate check answered and no
 * row exists at all (`watching: false`), which never enters the delivery state machine.
 */
export type CreateDashboardAgentWatchResult =
  | {
      ok: true;
      watching: true;
      watchId: string;
      identity: string;
      status: WatchStatus;
      expiresAt: Date;
      /** Set when the creation-time check couldn't run. The watch is active anyway. */
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
 * Existence check for the thing a spec points at, in this environment. `error_recurrence`
 * has nothing to validate: zero occurrences so far is the normal case.
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
 * Create a watch for an already-authorized context. The order is load-bearing (cap, dedup,
 * immediate check, create), and a first tick that can't be scheduled cancels the row.
 */
export async function createDashboardAgentWatch(params: {
  environment: AuthenticatedEnvironment;
  userId: string;
  chatId: string;
  spec: WatchSpec;
  /** Consent to investigate after an attention outcome. Never inferred. */
  investigateOnAttention?: boolean;
  now?: Date;
  /** IO seams: tests inject fakes here instead of mocking the readers. */
  deps?: {
    checkDeps?: (environment: AuthenticatedEnvironment, now: Date) => WatchCheckDeps;
    scheduleTick?: typeof scheduleWatchTick;
    /** Skip the real trigger-config gate when a tick scheduler is injected. */
    configured?: () => boolean;
  };
}): Promise<CreateDashboardAgentWatchResult> {
  const { environment, userId, chatId, spec } = params;
  const now = params.now ?? new Date();
  // Creation reads the target on the primary; the polling checks stay on the replica.
  const buildCheckDeps = params.deps?.checkDeps ?? watchCreationCheckDeps;
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

  // Advisory only: `createWatch` below re-applies both guardrails atomically and
  // stays the authority.
  const precheck = await precheckWatchCreation(dashboardAgentDb, {
    chatId,
    projectId: environment.projectId,
    environmentId: environment.id,
    identity,
  });
  if (!precheck.ok) return creationGuardrailError(precheck);

  // `since` is server-set so the model can't backdate a recurrence window.
  const persistedSpec: PersistedWatchSpec =
    spec.kind === "error_recurrence" ? { ...spec, since: now.toISOString() } : spec;

  // Answer in the same turn when the condition has already happened.
  const immediate = await checkWatch(persistedSpec, checkDeps, { now, since: now }, (error) =>
    logger.error("Dashboard agent watch: immediate check failed", { chatId, identity, error })
  );

  if (immediate.result === "satisfied" || immediate.result === "terminal_unsatisfied") {
    // Nothing is persisted: no row means no delivery claim and no wake.
    return { ok: true, watching: false, identity, immediate };
  }

  const expiresAt = new Date(now.getTime() + spec.maxHours * 60 * 60 * 1000);

  const created = await createWatch(dashboardAgentDb, {
    chatId,
    identity,
    spec: persistedSpec,
    organizationId: environment.organizationId,
    projectId: environment.projectId,
    // The external ref travels with the row: the agent can't translate the internal id.
    projectRef: environment.project.externalRef,
    environmentId: environment.id,
    userId,
    expiresAt,
    investigateOnAttention: params.investigateOnAttention === true,
  });

  if (!created.ok) {
    if (created.error === "chat_not_found") {
      // The chat was deleted mid-create. The query layer re-reads it under the
      // per-chat lock, so nothing was written.
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
      // Each invocation claims its own generation atomically, so the first is
      // `tickCount + 1`.
      tick: watch.tickCount + 1,
    });
  } catch (error) {
    logger.error("Dashboard agent watch: failed to schedule the first tick", {
      id: watch.id,
      error,
    });
    // Cancelled rather than resolved, because the condition was never evaluated.
    // Cancellation is silent, so no wake is sent.
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

/* ------------------------------------------------------------------ *
 * The card submit: a durable record of the request, then the watch
 * ------------------------------------------------------------------ */

/** A stored transcript record. Deterministic, so a retry rewrites the same bytes. */
export type WatchTranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  parts: unknown[];
};

export type SubmitWatchCardResult =
  | {
      ok: true;
      chatId: string;
      watching: boolean;
      watchId: string | null;
      /** The request record and the confirmation, in transcript order. */
      messages: WatchTranscriptMessage[];
      /** The watch already existed and this call only filled in a missing record. */
      repaired: boolean;
    }
  | {
      ok: false;
      code: CreateWatchErrorCode;
      error: string;
      existingId?: string | null;
      /** Set once a chat exists, so the caller can still open it. */
      chatId?: string;
    };

/**
 * A fresh panel's chat id, derived from the request id so a retried submit lands in the
 * chat the first attempt created instead of leaving an empty one behind. The user id is
 * mixed in so a client-chosen request id can never name another user's chat.
 */
function chatIdForRequest(userId: string, clientRequestId: string): string {
  const digest = createHash("sha256").update(`${userId}:${clientRequestId}`).digest("hex");
  return `chat_${digest.slice(0, 24)}`;
}

/**
 * A spec's comparable form. `since` is server-set on every attempt, so it is excluded:
 * two attempts at the same request differ by it and are still the same request.
 */
function comparableSpec(spec: WatchSpec | PersistedWatchSpec): string {
  const entries = Object.entries(spec as Record<string, unknown>)
    .filter(([key]) => key !== "since")
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

/**
 * Whether an existing watch is the one this submission asked for. A retry is byte-identical,
 * so anything else — a different window, cadence, note or investigate consent — is a genuinely
 * different request and still conflicts. `notifyExternally` is not persisted on the row, so it
 * is not compared; the subscribe below is idempotent and converges instead.
 */
function isSameWatchRequest(existing: Watch, draft: WatchDraft): boolean {
  return (
    comparableSpec(existing.spec) === comparableSpec(draft.spec) &&
    existing.investigateOnAttention === draft.followUp.investigateOnAttention
  );
}

/** The record of what the user confirmed. Written with no model call. */
function requestMessage(clientRequestId: string, draft: WatchDraft): WatchTranscriptMessage {
  return {
    id: `${WATCH_REQUEST_MESSAGE_ID_PREFIX}${clientRequestId}`,
    role: "user",
    parts: [
      { type: "text", text: watchRequestSentence({ spec: draft.spec, followUp: draft.followUp }) },
    ],
  };
}

/** The confirmation block, keyed on the watch so a repair rebuilds exactly the same record. */
function confirmationMessage(args: {
  id: string;
  blockId: string;
  body: Record<string, unknown>;
}): WatchTranscriptMessage {
  return {
    id: args.id,
    role: "assistant",
    parts: [
      {
        type: "data-view",
        data: {
          blocks: [
            { ...args.body, revision: 0, version: VIEW_BLOCK_VERSION, id: `watch:${args.blockId}` },
          ],
        },
      },
    ],
  };
}

/**
 * Submit a configured watch card, for an already-authorized environment and a chat the caller
 * owns.
 *
 * The ordering is the invariant: the record of what the user confirmed is written *before*
 * anything starts running, and the confirmation is written after. A crash in between leaves a
 * watch that is visible but unconfirmed, never one that is live and invisible — and a retry
 * repairs it, because both records carry stable ids and a duplicate watch is loaded rather
 * than refused.
 */
export async function submitDashboardAgentWatch(params: {
  environment: AuthenticatedEnvironment;
  userId: string;
  organizationId: string;
  /** The chat the card was submitted from. A fresh panel has none, so one is created. */
  chatId?: string;
  /** Stable per card submission: both transcript records are keyed off it. */
  clientRequestId: string;
  draft: WatchDraft;
  now?: Date;
  deps?: {
    create?: typeof createDashboardAgentWatch;
    subscribe?: typeof subscribeUserToWatchAlerts;
  } & NonNullable<Parameters<typeof createDashboardAgentWatch>[0]["deps"]>;
}): Promise<SubmitWatchCardResult> {
  const { environment, userId, organizationId, clientRequestId, draft } = params;
  const create = params.deps?.create ?? createDashboardAgentWatch;
  const subscribe = params.deps?.subscribe ?? subscribeUserToWatchAlerts;

  const chatId = params.chatId ?? chatIdForRequest(userId, clientRequestId);
  if (!params.chatId) {
    // Idempotent on the id, so a retry reuses the same chat rather than making another.
    await createChat(dashboardAgentDb, {
      id: chatId,
      organizationId,
      userId,
      title: `Watch ${watchSubjectLabel(draft.spec)}`,
    });
  }

  // Step one, before the watch can exist: a false here means the record is already
  // there from an earlier attempt, and a deleted chat is caught by the create below.
  const request = requestMessage(clientRequestId, draft);
  await appendChatMessageOnce(dashboardAgentDb, { chatId, userId, message: request });

  let result = await create({
    environment,
    userId,
    chatId,
    spec: draft.spec,
    investigateOnAttention: draft.followUp.investigateOnAttention,
    now: params.now,
    deps: params.deps,
  });

  // A duplicate is a retry until proven otherwise: the same request repairs whatever
  // record is missing, a different one still conflicts.
  let repaired = false;
  if (!result.ok && result.code === "duplicate" && result.existingId) {
    const existing = await getWatch(dashboardAgentDb, { id: result.existingId });
    if (
      existing &&
      existing.chatId === chatId &&
      existing.status === "active" &&
      isSameWatchRequest(existing, draft)
    ) {
      repaired = true;
      result = {
        ok: true,
        watching: true,
        watchId: existing.id,
        identity: existing.identity,
        status: existing.status,
        expiresAt: existing.expiresAt,
      };
    }
  }

  if (!result.ok) {
    return { ...result, chatId };
  }

  // Attached after the watch exists, and a refusal never fails the creation.
  let notifiedExternally = false;
  if (result.watching && draft.followUp.notifyExternally) {
    notifiedExternally = (await subscribe({ userId, environment })).ok;
  }

  const confirmation = result.watching
    ? confirmationMessage({
        id: `${WATCH_CONFIRMATION_MESSAGE_ID_PREFIX}${result.watchId}`,
        blockId: result.watchId,
        body: watchConfirmationBlockBody({
          spec: draft.spec,
          watchId: result.watchId,
          unavailable: result.unavailable,
          followUp: {
            investigateOnAttention: draft.followUp.investigateOnAttention,
            notifyExternally: notifiedExternally,
          },
        }),
      })
    : confirmationMessage({
        // No watch exists, so the request id is the only stable key for a one-shot.
        id: `${WATCH_CONFIRMATION_MESSAGE_ID_PREFIX}one-shot:${clientRequestId}`,
        blockId: result.identity,
        body: watchOneShotBlockBody({
          spec: draft.spec,
          result: result.immediate.result as "satisfied" | "terminal_unsatisfied",
        }),
      });

  await appendChatMessageOnce(dashboardAgentDb, { chatId, userId, message: confirmation });

  return {
    ok: true,
    chatId,
    watching: result.watching,
    watchId: result.watching ? result.watchId : null,
    messages: [request, confirmation],
    repaired,
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
 * Trigger one tick of the watcher task, as the agent's own environment. The token travels
 * in the payload, not the database: signing is a pure function of the watch row.
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
    { watchId: params.watchId, token: params.token, apiOrigin, tick: params.tick },
    {
      delay: `${params.delayMinutes}m`,
      // Keyed on the generation the payload carries, so a retried schedule can't double-tick.
      idempotencyKey: `watch:${params.watchId}:tick:${params.tick}`,
      // Pin to the same deployed agent version the chat runs on, when set.
      ...(env.DASHBOARD_AGENT_VERSION ? { version: env.DASHBOARD_AGENT_VERSION } : {}),
    }
  );
}

/** The task that polls a whole (environment, cadence) group. */
export const WATCH_BATCH_TASK_ID = "dashboard-agent-watch-batch";

/**
 * How long a chain may go silent before it is treated as dead and re-armed. Three cadences
 * plus two minutes, so a tick's jitter and retries can't trip it.
 */
export function watchBatchStaleMs(cadenceMinutes: number): number {
  return cadenceMinutes * 60_000 * 3 + 2 * 60_000;
}

/**
 * Make sure a chain is polling one (environment, cadence) group. A failed trigger un-arms the
 * row, since a chain marked running with no run behind it leaves its group unpolled.
 */
export async function armDashboardAgentWatchBatch(params: {
  environmentId: string;
  cadenceMinutes: number;
  now?: Date;
  deps?: {
    arm?: typeof armWatchBatch;
    schedule?: typeof scheduleWatchBatchTick;
    stop?: typeof stopWatchBatch;
  };
}): Promise<{ running: boolean }> {
  const now = params.now ?? new Date();
  const arm = params.deps?.arm ?? armWatchBatch;
  const schedule = params.deps?.schedule ?? scheduleWatchBatchTick;
  const stop = params.deps?.stop ?? stopWatchBatch;

  const armed = await arm(dashboardAgentDb, {
    environmentId: params.environmentId,
    cadenceMinutes: params.cadenceMinutes,
    staleBefore: new Date(now.getTime() - watchBatchStaleMs(params.cadenceMinutes)),
  });

  // A live chain already covers the group.
  if (!armed) return { running: true };

  try {
    await schedule({
      environmentId: params.environmentId,
      cadenceMinutes: params.cadenceMinutes,
      epoch: armed.epoch,
      // A claim lands on `generation + 1`.
      tick: armed.generation + 1,
      delayMinutes: params.cadenceMinutes,
    });
  } catch (error) {
    logger.error("Dashboard agent watch: failed to start a batch chain", {
      environmentId: params.environmentId,
      cadenceMinutes: params.cadenceMinutes,
      error,
    });
    await stop(dashboardAgentDb, {
      environmentId: params.environmentId,
      cadenceMinutes: params.cadenceMinutes,
      epoch: armed.epoch,
    });
    return { running: false };
  }

  return { running: true };
}

/**
 * Trigger one tick of a batch chain, as the agent's own environment. The chain's token names the
 * group and nothing else; the batch check re-authorizes every watch against its own snapshot.
 */
export async function scheduleWatchBatchTick(params: {
  environmentId: string;
  cadenceMinutes: number;
  epoch: number;
  tick: number;
  delayMinutes: number;
}): Promise<void> {
  const accessToken = env.DASHBOARD_AGENT_SECRET_KEY;
  if (!accessToken) throw new Error("DASHBOARD_AGENT_SECRET_KEY is not set");

  const apiOrigin = dashboardAgentApiOrigin();
  const client = new TriggerClient({ baseURL: apiOrigin, accessToken });
  const token = await mintDashboardAgentWatchBatchToken({
    environmentId: params.environmentId,
    cadenceMinutes: params.cadenceMinutes,
  });

  await client.tasks.trigger(
    WATCH_BATCH_TASK_ID,
    {
      environmentId: params.environmentId,
      cadenceMinutes: params.cadenceMinutes,
      apiOrigin,
      token,
      epoch: params.epoch,
      tick: params.tick,
    },
    {
      delay: `${params.delayMinutes}m`,
      // The chain's own key shape, epoch included, so a re-armed chain can't collide
      // with its predecessor's keys.
      idempotencyKey: `watch-batch:${params.environmentId}:${params.cadenceMinutes}:${params.epoch}:tick:${params.tick}`,
      ...(env.DASHBOARD_AGENT_VERSION ? { version: env.DASHBOARD_AGENT_VERSION } : {}),
    }
  );
}

/**
 * Hand a resolved watch's wake to the watcher task, since only the agent project may append to a
 * chat's `in` stream. Keyed per watch with a short TTL, so a later sweep can still retry.
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

/**
 * Delete a chat and end its watches in one transaction, so no live watch is left on an
 * invisible chat. Owner-scoped, so a chatId the caller doesn't own deletes nothing.
 */
export async function deleteChatWithWatches(params: {
  chatId: string;
  userId: string;
}): Promise<{ deleted: boolean; cancelledWatches: number }> {
  const result = await softDeleteChat(dashboardAgentDb, params);
  return { deleted: result.deleted, cancelledWatches: result.cancelledWatches.length };
}

/** Dates are strings because this crosses a loader's JSON boundary. */
export type ChatWatchChip = {
  id: string;
  identity: string;
  status: WatchStatus;
  kind: string;
  note: string;
  checkEveryMinutes: number;
  expiresAt: string;
  endedReason: string | null;
  /** How the watch ended. Null while active. */
  resolution: WatchResolution | null;
  /** What the resolving check observed. */
  observedOutcome: WatchObservedOutcome | null;
};

/**
 * Active watches for many chats in one query, keyed by chatId. The query layer re-scopes the
 * chat ids by org and user, so this is safe with ids from any source.
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

export function chatBelongsToUser(params: {
  chatId: string;
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  return chatExists(dashboardAgentDb, params);
}

export type { ChatWatchContext };

/**
 * Ownership check for a chat, plus its org, the tenancy floor its watches can't leave. No
 * project or environment: those come from the authorized request context.
 */
export function resolveChatWatchContext(params: {
  chatId: string;
  userId: string;
}): Promise<ChatWatchContext | null> {
  return getChatWatchContext(dashboardAgentDb, params);
}
