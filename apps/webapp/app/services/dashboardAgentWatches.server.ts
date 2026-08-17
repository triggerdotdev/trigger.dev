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
  claimWatchSubmission,
  countActiveWatchesForOrg,
  createChat,
  createWatch,
  generateWatchId,
  getChatWatchContext,
  getWatch,
  getWatchSubmission,
  listActiveWatchesForChats as listActiveWatchesForChatsQuery,
  precheckWatchCreation,
  recordWatchSubmissionOutcome,
  reopenWatchSubmission,
  softDeleteChat,
  stopWatchBatch,
  type ChatWatchContext,
  type PersistedWatchSpec,
  type Watch,
  type WatchStatus,
  type WatchSubmission,
} from "@internal/dashboard-agent-db";
import {
  VIEW_BLOCK_VERSION,
  WATCH_CANCELLED_MESSAGE_ID_PREFIX,
  WATCH_CONFIRMATION_MESSAGE_ID_PREFIX,
  WATCH_REQUEST_MESSAGE_ID_PREFIX,
  watchCancelledSentence,
  watchConfirmationBlockBody,
  watchDraftSchema,
  watchIdentity,
  watchOneShotBlockBody,
  watchRequestSentence,
  watchResolvedBlockBody,
  watchSubjectLabel,
  type WatchDraft,
  type WatchExternalNotification,
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
import { normalizeErrorFingerprint } from "~/services/dashboardAgentWatchErrorChecks";
import { subscribeUserToWatchAlerts } from "~/services/dashboardAgentWatchAlerts.server";
import {
  effectiveWatchMaxHours,
  resolveWatchPlanLimits,
  watchLimitHint,
  type WatchPlanLimits,
} from "~/services/dashboardAgentWatchLimits.server";
import {
  mintDashboardAgentWatchBatchToken,
  mintDashboardAgentWatchToken,
} from "~/services/dashboardAgentWatchToken.server";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";

/** The task that polls a watch. Lives in the agent project, triggered by us. */
const WATCH_TASK_ID = "dashboard-agent-watch";

;

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

type CreateWatchErrorCode =
  | "limit_reached"
  | "watch_limit_reached"
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

/** The one spelling of a spec's target that the identity, the checks and the link all share. */
function normalizeWatchSpec(spec: WatchSpec): WatchSpec {
  if (spec.kind !== "error_recurrence") return spec;
  return { ...spec, fingerprint: normalizeErrorFingerprint(spec.fingerprint) };
}

const TASK_QUEUE_PREFIX = "task/";

/**
 * The queue name as stored, from whatever the caller called it. The model can't tell a
 * task queue (`task/<task id>`) from a custom one (a plain name), so both spellings are
 * tried and the stored one wins. `null` means no queue by either name.
 */
async function resolveQueueName(queue: string, deps: WatchCheckDeps): Promise<string | null> {
  const alternative = queue.startsWith(TASK_QUEUE_PREFIX)
    ? queue.slice(TASK_QUEUE_PREFIX.length)
    : `${TASK_QUEUE_PREFIX}${queue}`;
  for (const candidate of [queue, alternative]) {
    if (candidate.length > 0 && (await deps.queueExists(candidate))) return candidate;
  }
  return null;
}

/**
 * Resolve the thing a spec points at, in this environment, returning the spec the identity
 * and the checks will see. `null` means the target doesn't exist. `error_recurrence` has
 * nothing to validate: zero occurrences so far is the normal case.
 */
async function resolveWatchTarget(
  spec: WatchSpec,
  deps: WatchCheckDeps
): Promise<WatchSpec | null> {
  switch (spec.kind) {
    case "run_start":
    case "run_finished":
    case "run_failed":
      return (await deps.readRun(spec.runId)) !== null ? spec : null;
    case "backlog_drain":
    case "queue_depth_above":
    case "queue_depth_below":
    case "queue_stalled":
    case "queue_oldest_age": {
      const queue = await resolveQueueName(spec.queue, deps);
      return queue === null ? null : { ...spec, queue };
    }
    case "error_recurrence":
      return spec.fingerprint.length > 0 ? spec : null;
    case "health_recovery":
      return isReportKey(spec.report) ? spec : null;
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
  /** Reserved by the submission ledger, so a converging retry finds the row by id. */
  watchId?: string;
  now?: Date;
  /** IO seams: tests inject fakes here instead of mocking the readers. */
  deps?: {
    checkDeps?: (environment: AuthenticatedEnvironment, now: Date) => WatchCheckDeps;
    scheduleTick?: typeof scheduleWatchTick;
    /** Skip the real trigger-config gate when a tick scheduler is injected. */
    configured?: () => boolean;
    /** Plan floors on window and count. Fails open to unlimited when absent. */
    resolveLimits?: (organizationId: string) => Promise<WatchPlanLimits>;
    /** Org-wide active-watch count, for the watcher-count floor. */
    countActiveWatches?: (organizationId: string) => Promise<number>;
    /** Gates the upgrade nudge, so self-hosted stays quiet. */
    billingConfigured?: () => boolean;
  };
}): Promise<CreateDashboardAgentWatchResult> {
  const { environment, userId, chatId } = params;
  // Normalized before anything reads it: the page cites `error_<fingerprint>` and the tools
  // cite the bare one, and only one of the two spellings may reach the identity or the link.
  const requestedSpec = normalizeWatchSpec(params.spec);
  const now = params.now ?? new Date();
  // Creation reads the target on the primary; the polling checks stay on the replica.
  const buildCheckDeps = params.deps?.checkDeps ?? watchCreationCheckDeps;
  const scheduleTick = params.deps?.scheduleTick ?? scheduleWatchTick;
  const isDashboardAgentConfigured = params.deps?.configured ?? isDashboardAgentConfiguredDefault;
  const resolveLimits = params.deps?.resolveLimits ?? resolveWatchPlanLimits;
  const countActiveWatches =
    params.deps?.countActiveWatches ??
    ((organizationId: string) => countActiveWatchesForOrg(dashboardAgentDb, { organizationId }));
  const hint = (base: string) => watchLimitHint(base, params.deps?.billingConfigured?.());
  const checkDeps = buildCheckDeps(environment, now);

  if (!isDashboardAgentConfigured()) {
    return {
      ok: false,
      code: "not_configured",
      error: "The dashboard agent is not configured, so watches can't be scheduled.",
    };
  }

  // Resolution rewrites the target's name, so the identity, the readers and the wording all
  // see the stored one. A spec kept as asked would read the depth of a queue that isn't there.
  const spec = await resolveWatchTarget(requestedSpec, checkDeps);
  if (spec === null) {
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

  // Both floors are read only now the immediate check didn't answer: a one-shot creates no
  // row, so a plan floor must not turn an answerable question into an upgrade nudge. Plan
  // floors sit below the code ceilings (min(plan, ceiling)) and fail open: an absent limit
  // resolves to unlimited, so neither bites on self-hosted.
  const planLimits = await resolveLimits(environment.organizationId);
  if (spec.maxHours > effectiveWatchMaxHours(planLimits.maxHours)) {
    return {
      ok: false,
      code: "watch_limit_reached",
      error: hint("That watch window is longer than your plan allows."),
    };
  }

  // The per-chat cap of 3 still applies independently, in `createWatch`.
  const activeCount = await countActiveWatches(environment.organizationId);
  if (activeCount >= planLimits.watchers) {
    return {
      ok: false,
      code: "watch_limit_reached",
      error: hint("You've reached the number of active watches your plan allows."),
    };
  }

  const expiresAt = new Date(now.getTime() + spec.maxHours * 60 * 60 * 1000);

  const created = await createWatch(dashboardAgentDb, {
    ...(params.watchId ? { id: params.watchId } : {}),
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

/** A submit can also refuse a request id that arrives carrying a different draft. */
export type SubmitWatchErrorCode = CreateWatchErrorCode | "request_conflict";

export type SubmitWatchCardResult =
  | {
      ok: true;
      chatId: string;
      watching: boolean;
      watchId: string | null;
      /** The request record and the confirmation, in transcript order. */
      messages: WatchTranscriptMessage[];
      /** Nothing was created: this call replayed a recorded outcome. */
      repaired: boolean;
    }
  | {
      ok: false;
      code: SubmitWatchErrorCode;
      error: string;
      existingId?: string | null;
      /** Set once a chat exists, so the caller can still open it. */
      chatId?: string;
    };

/**
 * A fresh panel's chat id, derived from the request id so a retried submit lands in the
 * chat the first attempt created instead of leaving an empty one behind.
 *
 * The whole tenancy of the request is mixed in, not just the user: `clientRequestId` is
 * client-chosen, and one user can be in several organizations, so a user id alone lets two
 * organizations derive the same id — where `createChat(...).onConflictDoNothing()` keeps
 * the first org's chat and the second org's records land in it.
 */
function chatIdForRequest(params: {
  organizationId: string;
  userId: string;
  environmentId: string;
  clientRequestId: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `${params.organizationId}:${params.userId}:${params.environmentId}:${params.clientRequestId}`
    )
    .digest("hex");
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
 * different request and still conflicts. `notifyExternally` is not on the watch row, so it is
 * compared through the ledger's draft digest instead, which covers the whole configuration.
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
 * A submitted draft's comparable digest: the whole confirmed configuration, `notifyExternally`
 * included. It is user consent, and the transcript records it, so a retry that flips it is a
 * different request — not something to converge on behind the durable record.
 */
function draftDigest(draft: WatchDraft): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        comparableSpec(draft.spec),
        draft.followUp.investigateOnAttention,
        draft.followUp.notifyExternally,
      ])
    )
    .digest("hex");
}

/** The recorded outcome of the external consent, replayed rather than re-decided. */
function recordedExternalNotification(recorded: WatchSubmission): WatchExternalNotification {
  if (recorded.externalNotificationStatus === "enabled") return { status: "enabled" };
  if (recorded.externalNotificationStatus === "unavailable") {
    return { status: "unavailable", reason: recorded.externalNotificationReason ?? "unknown" };
  }
  return { status: "not_requested" };
}

/** The draft the ledger recorded, which is what a replay must be built from. */
function recordedDraft(recorded: WatchSubmission, fallback: WatchDraft): WatchDraft {
  const parsed = watchDraftSchema.safeParse(recorded.draft);
  return parsed.success ? parsed.data : fallback;
}

/** The refusal record, keyed off the request so a retry's success can still follow it. */
function refusalMessage(clientRequestId: string, error: string): WatchTranscriptMessage {
  return {
    id: `${WATCH_CONFIRMATION_MESSAGE_ID_PREFIX}refused:${clientRequestId}`,
    role: "assistant",
    parts: [{ type: "text", text: error }],
  };
}

/**
 * Submit a configured watch card, for an already-authorized environment and a chat the caller
 * owns.
 *
 * The submission ledger is the idempotency boundary, not the transcript ids: a row keyed
 * `(chatId, clientRequestId)` is written *before* the condition is evaluated, and it carries
 * the outcome once there is one. So a retry looks the submission up first and replays what
 * was recorded — it never re-evaluates and never creates a second operation, even after the
 * first watch has fired, expired or answered in one shot. Only a `pending` row, left by an
 * attempt that died before writing its outcome, is allowed to proceed, and it converges on
 * the watch id reserved up front rather than creating another.
 *
 * The transcript ordering is the second invariant: the record of what the user confirmed is
 * written before anything starts running, and the confirmation after, so a crash can leave a
 * watch that is visible but unconfirmed, never one that is live and invisible.
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

  const chatId =
    params.chatId ??
    chatIdForRequest({
      organizationId,
      userId,
      environmentId: environment.id,
      clientRequestId,
    });
  if (!params.chatId) {
    // Idempotent on the id, so a retry reuses the same chat rather than making another.
    await createChat(dashboardAgentDb, {
      id: chatId,
      organizationId,
      userId,
      title: `Watch ${watchSubjectLabel(draft.spec)}`,
    });
  }

  const digest = draftDigest(draft);
  const request = requestMessage(clientRequestId, draft);

  /** Append-once, then return. Both records are deterministic, so a replay rewrites bytes. */
  const settle = async (args: {
    confirmation: WatchTranscriptMessage;
    watchId: string | null;
    repaired: boolean;
  }): Promise<SubmitWatchCardResult> => {
    await appendChatMessageOnce(dashboardAgentDb, {
      chatId,
      userId,
      organizationId,
      message: args.confirmation,
    });
    return {
      ok: true,
      chatId,
      watching: args.watchId !== null,
      watchId: args.watchId,
      messages: [request, args.confirmation],
      repaired: args.repaired,
    };
  };

  /** `confirmed` is the draft the confirmation speaks for: the recorded one on a replay. */
  const watchingConfirmation = (args: {
    watchId: string;
    unavailable: boolean;
    external: WatchExternalNotification;
    confirmed?: WatchDraft;
    /** The row this settles against, when the caller already read it. */
    watch?: Watch | null;
  }) => {
    const confirmed = args.confirmed ?? draft;
    // A retry can settle against a watch that already ran: say what it found, not "watching".
    const resolution = args.watch?.status !== "active" ? args.watch?.resolution : null;
    if (args.watch && resolution) {
      return confirmationMessage({
        id: `${WATCH_CONFIRMATION_MESSAGE_ID_PREFIX}${args.watchId}`,
        blockId: args.watchId,
        body: watchResolvedBlockBody({
          watchId: args.watchId,
          resolved: {
            kind: confirmed.spec.kind,
            identity: args.watch.identity,
            resolution,
            observed: args.watch.observedOutcome,
          },
        }),
      });
    }
    return confirmationMessage({
      id: `${WATCH_CONFIRMATION_MESSAGE_ID_PREFIX}${args.watchId}`,
      blockId: args.watchId,
      body: watchConfirmationBlockBody({
        spec: confirmed.spec,
        watchId: args.watchId,
        unavailable: args.unavailable,
        followUp: {
          investigateOnAttention: confirmed.followUp.investigateOnAttention,
          external: args.external,
        },
      }),
    });
  };

  const oneShotConfirmation = (
    result: "satisfied" | "terminal_unsatisfied",
    confirmed: WatchDraft = draft
  ) =>
    confirmationMessage({
      // No watch exists, so the request id is the only stable key for a one-shot.
      id: `${WATCH_CONFIRMATION_MESSAGE_ID_PREFIX}one-shot:${clientRequestId}`,
      blockId: watchIdentity(confirmed.spec),
      body: watchOneShotBlockBody({ spec: confirmed.spec, result }),
    });

  /**
   * Rebuild the transcript from a recorded outcome. Nothing is evaluated or created, and
   * the record is built from the recorded draft, never the body of this attempt: the
   * durable user message states what the first attempt confirmed.
   */
  const replay = async (recorded: WatchSubmission): Promise<SubmitWatchCardResult> => {
    const confirmed = recordedDraft(recorded, draft);

    if (recorded.state === "created" && recorded.watchId) {
      return settle({
        confirmation: watchingConfirmation({
          watchId: recorded.watchId,
          unavailable: recorded.unavailable,
          // Recorded, never re-decided: the confirmation already in the transcript is
          // append-once, so a second decision here would contradict it forever.
          external: recordedExternalNotification(recorded),
          confirmed,
        }),
        watchId: recorded.watchId,
        repaired: true,
      });
    }

    if (recorded.state === "immediate") {
      return settle({
        confirmation: oneShotConfirmation(
          recorded.immediateResult === "satisfied" ? "satisfied" : "terminal_unsatisfied",
          confirmed
        ),
        watchId: null,
        repaired: true,
      });
    }

    // Refused. Replayed verbatim, so the transcript and the response agree.
    const error = recorded.refusalError ?? "That watch couldn't be started.";
    await appendChatMessageOnce(dashboardAgentDb, {
      chatId,
      userId,
      organizationId,
      message: refusalMessage(clientRequestId, error),
    });
    return {
      ok: false,
      chatId,
      code: (recorded.refusalCode as SubmitWatchErrorCode | null) ?? "internal",
      error,
      existingId: recorded.refusalExistingId,
    };
  };

  /**
   * Record a refusal, then write it under the consent record rather than leaving it to a
   * toast the reload forgets. Losing the write means another attempt already settled it.
   */
  const refuse = async (refusal: {
    code: SubmitWatchErrorCode;
    error: string;
    existingId?: string | null;
  }): Promise<SubmitWatchCardResult> => {
    const recorded = await recordWatchSubmissionOutcome(dashboardAgentDb, {
      chatId,
      clientRequestId,
      state: "refused",
      refusalCode: refusal.code,
      refusalError: refusal.error,
      refusalExistingId: refusal.existingId ?? null,
    });
    if (!recorded) {
      const winner = await getWatchSubmission(dashboardAgentDb, { chatId, clientRequestId });
      if (winner && winner.state !== "pending") return replay(winner);
    }
    await appendChatMessageOnce(dashboardAgentDb, {
      chatId,
      userId,
      organizationId,
      message: refusalMessage(clientRequestId, refusal.error),
    });
    return { ok: false, chatId, ...refusal };
  };

  // Step one, before the condition is even read: the ledger row. Its primary key is what
  // makes a retry a replay instead of a second operation.
  const claim = await claimWatchSubmission(dashboardAgentDb, {
    chatId,
    clientRequestId,
    organizationId,
    userId,
    projectId: environment.projectId,
    environmentId: environment.id,
    draftHash: digest,
    draft: { spec: draft.spec, followUp: draft.followUp } as unknown as Record<string, unknown>,
    watchId: generateWatchId(),
  });

  // A chat can by design span environments, so a matching draft is not enough: the row
  // has to have been written by this same tenancy, or a staging retry would replay a
  // production watch. A mismatch is refused, never replayed.
  const recordedScope = claim.submission;
  if (
    recordedScope.organizationId !== organizationId ||
    recordedScope.userId !== userId ||
    recordedScope.projectId !== environment.projectId ||
    recordedScope.environmentId !== environment.id
  ) {
    return {
      ok: false,
      chatId,
      code: "request_conflict",
      error: "That request was already submitted somewhere else.",
    };
  }

  // A different draft under the same request id is a different request, not a retry.
  if (claim.submission.draftHash !== digest) {
    return {
      ok: false,
      chatId,
      code: "request_conflict",
      error: "That request was already submitted with different settings.",
    };
  }

  // Step two, before the watch can exist: a false here means the record is already there
  // from an earlier attempt, and a deleted chat is caught by the create below.
  await appendChatMessageOnce(dashboardAgentDb, {
    chatId,
    userId,
    organizationId,
    message: request,
  });

  let submission = claim.submission;

  // A recorded outcome is replayed. A refusal produced no side effect, so it is the one
  // state that may be attempted again — under a fresh reserved id, since the old one may
  // already name a cancelled row.
  if (submission.state === "refused") {
    const reopened = await reopenWatchSubmission(dashboardAgentDb, {
      chatId,
      clientRequestId,
      watchId: generateWatchId(),
    });
    if (!reopened) {
      const current = await getWatchSubmission(dashboardAgentDb, { chatId, clientRequestId });
      if (current && current.state !== "pending") return replay(current);
      return refuse({ code: "internal", error: "That watch couldn't be started." });
    }
    submission = reopened;
  } else if (submission.state !== "pending") {
    return replay(submission);
  }

  /** Attach the channel, record the outcome, then confirm. A lost race replays the winner. */
  const settleCreated = async (args: {
    watchId: string;
    unavailable: boolean;
    /** The watch was already there: this call adopted it rather than creating it. */
    adopted: boolean;
    /** The adopted row. Absent when this call created the watch, so it is active. */
    watch?: Watch | null;
  }): Promise<SubmitWatchCardResult> => {
    // Attached after the watch exists, and a failure here never fails the creation — it is
    // said out loud in the confirmation instead, and recorded so a replay repeats it.
    let external: WatchExternalNotification = { status: "not_requested" };
    if (draft.followUp.notifyExternally) {
      const subscribed = await subscribe({ userId, environment });
      external = subscribed.ok
        ? { status: "enabled" }
        : { status: "unavailable", reason: subscribed.reason };
    }

    const recorded = await recordWatchSubmissionOutcome(dashboardAgentDb, {
      chatId,
      clientRequestId,
      state: "created",
      watchId: args.watchId,
      unavailable: args.unavailable,
      external,
    });
    if (!recorded) {
      const winner = await getWatchSubmission(dashboardAgentDb, { chatId, clientRequestId });
      if (winner && winner.state !== "pending") {
        // The winning outcome doesn't name this watch as created, so this watch is an orphan:
        // cancel it before replaying, or a refusal would leave a live watch behind.
        if (!(winner.state === "created" && winner.watchId === args.watchId)) {
          await cancelWatch(dashboardAgentDb, { id: args.watchId, reason: "superseded" });
        }
        return replay(winner);
      }
    }

    return settle({
      confirmation: watchingConfirmation({
        watchId: args.watchId,
        watch: args.watch,
        unavailable: args.unavailable,
        external,
      }),
      watchId: args.watchId,
      repaired: args.adopted,
    });
  };

  // Converge: an attempt that died mid-create left its row under the reserved id.
  const reservedWatchId = submission.watchId ?? generateWatchId();
  const reserved = await getWatch(dashboardAgentDb, { id: reservedWatchId });
  if (reserved) {
    if (reserved.status === "cancelled") {
      // The previous attempt created it and then took it back. The id is spent, so this
      // submission can't be completed; a fresh submit gets a fresh request id.
      return refuse({
        code: "internal",
        error: "The watch couldn't be scheduled. Nothing is being watched.",
      });
    }
    // `unavailable` isn't recoverable here: it belonged to the attempt that died.
    return settleCreated({
      watchId: reserved.id,
      unavailable: false,
      adopted: true,
      watch: reserved,
    });
  }

  const result = await create({
    environment,
    userId,
    chatId,
    spec: draft.spec,
    investigateOnAttention: draft.followUp.investigateOnAttention,
    watchId: reservedWatchId,
    now: params.now,
    deps: params.deps,
  });

  if (!result.ok) {
    // Pre-ledger fallback: a submit that started before this ledger existed has no row of
    // its own, so an active watch matching the draft is still adopted rather than refused.
    // This only ever loads a watch; it never creates one.
    if (result.code === "duplicate" && result.existingId) {
      const existing = await getWatch(dashboardAgentDb, { id: result.existingId });
      if (
        existing &&
        existing.chatId === chatId &&
        existing.status === "active" &&
        isSameWatchRequest(existing, draft)
      ) {
        return settleCreated({ watchId: existing.id, unavailable: false, adopted: true });
      }
    }
    return refuse(result);
  }

  if (!result.watching) {
    const recorded = await recordWatchSubmissionOutcome(dashboardAgentDb, {
      chatId,
      clientRequestId,
      state: "immediate",
      // No watch exists, so the reserved id is released rather than left dangling.
      watchId: null,
      immediateResult: result.immediate.result,
    });
    if (!recorded) {
      const winner = await getWatchSubmission(dashboardAgentDb, { chatId, clientRequestId });
      if (winner && winner.state !== "pending") return replay(winner);
    }
    return settle({
      confirmation: oneShotConfirmation(
        result.immediate.result as "satisfied" | "terminal_unsatisfied"
      ),
      watchId: null,
      repaired: false,
    });
  }

  return settleCreated({
    watchId: result.watchId,
    unavailable: result.unavailable === true,
    adopted: false,
  });
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
const WATCH_BATCH_TASK_ID = "dashboard-agent-watch-batch";

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
 * Stop a watch the user asked to stop, and say so in the chat that owns it.
 *
 * Only this reason leaves a line: the other cancellations either take the chat with them or
 * already state themselves. `cancelWatch` is guarded on `active`, so a second cancel — or a
 * watch that resolved first — writes nothing, and the id keyed off the watch keeps a retry
 * from adding a second line. Deterministic: no wake, no delivery, no model.
 */
export async function cancelDashboardAgentWatch(params: {
  watchId: string;
  userId: string;
  organizationId: string;
}): Promise<{ cancelled: boolean; messages: WatchTranscriptMessage[] }> {
  const cancelled = await cancelWatch(dashboardAgentDb, { id: params.watchId, reason: "user" });
  if (!cancelled) return { cancelled: false, messages: [] };

  const message: WatchTranscriptMessage = {
    id: `${WATCH_CANCELLED_MESSAGE_ID_PREFIX}${cancelled.id}`,
    role: "assistant",
    parts: [{ type: "text", text: watchCancelledSentence(cancelled.spec) }],
  };
  await appendChatMessageOnce(dashboardAgentDb, {
    chatId: cancelled.chatId,
    userId: params.userId,
    organizationId: params.organizationId,
    message,
  });

  return { cancelled: true, messages: [message] };
}

/**
 * Delete a chat and end its watches in one transaction, so no live watch is left on an
 * invisible chat. Org- and owner-scoped, so a chatId the caller doesn't own deletes nothing.
 */
export async function deleteChatWithWatches(params: {
  chatId: string;
  userId: string;
  organizationId: string;
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

function chatBelongsToUser(params: {
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
