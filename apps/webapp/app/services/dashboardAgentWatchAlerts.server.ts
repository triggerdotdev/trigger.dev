/**
 * Watch alerts — the seam between a watch firing and the standard alert pipeline.
 *
 * A fired watch already wakes its chat; this is the *other* delivery: the
 * project's configured alert channels (email/Slack/webhook) that subscribe to
 * `DASHBOARD_AGENT_WATCH`. Same channel model as run failures and deployments, so
 * a user configures it once on the Alerts page and it works for every watch.
 *
 * Two things live here: the enqueue (called from every path that can fire a
 * watch) and the gate both the fan-out and the agent's subscribe endpoint consult.
 */

import { type Watch } from "@internal/dashboard-agent-db";
import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { alertsWorker } from "~/v3/alertsWorker.server";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";

/** The alert type a watch fires under. */
export const DASHBOARD_AGENT_WATCH_ALERT_TYPE = "DASHBOARD_AGENT_WATCH" as const;

/**
 * What the enqueue needs off a watch row. Declared as a shape rather than the
 * full row so both the fired callback (which reads the row) and the
 * fire-at-creation path (which has just written it) can hand one in.
 */
export type WatchFiredAlertSource = Pick<
  Watch,
  | "id"
  | "identity"
  | "spec"
  | "organizationId"
  | "projectId"
  | "environmentId"
  | "userId"
  | "firedAt"
  | "lastResult"
  | "resolution"
  | "observedOutcome"
>;

/**
 * Queue the alert fan-out for a watch that just resolved.
 *
 * Only `fired` dispatches. An expiry ("it didn't happen in 24h") is a chat-level
 * non-event — the agent narrates it in the conversation, and mailing it would
 * train people to ignore watch alerts. Kept in the signature so the callers read
 * the same either way.
 *
 * The job id is the whole idempotency story: one fan-out job per watch, so the
 * callback being retried, a tick redelivering, and the creation path racing the
 * watcher all collapse into a single alert. The fan-out then enqueues one job per
 * channel, itself keyed per channel.
 */
export async function enqueueWatchFiredAlert(
  watch: WatchFiredAlertSource,
  outcome: "fired" | "expired"
): Promise<void> {
  if (outcome !== "fired") return;

  await alertsWorker.enqueue({
    id: `watch-alert:${watch.id}`,
    job: "v3.deliverDashboardAgentWatchAlert",
    payload: {
      watchId: watch.id,
      organizationId: watch.organizationId,
      projectId: watch.projectId,
      environmentId: watch.environmentId,
      userId: watch.userId,
      identity: watch.identity,
      kind: watch.spec.kind,
      note: watch.spec.note,
      firedAt: (watch.firedAt ?? new Date()).toISOString(),
      facts: watch.lastResult ?? {},
      // The frozen resolved result — the email renders from these, never re-reading
      // the source. A fired watch is condition_met by construction.
      resolution: watch.resolution ?? "condition_met",
      observed: watch.observedOutcome ?? undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

export type DashboardAgentAlertDenyReason =
  /** The user can't use the dashboard agent, so its watches can't alert either. */
  | "dashboard_agent_disabled"
  /** This installation has no alert email transport configured. */
  | "email_alerts_not_configured";

export type DashboardAgentAlertGate =
  | { allowed: true }
  | { allowed: false; reason: DashboardAgentAlertDenyReason };

/**
 * May this user's watches alert at all? Operational checks only — the
 * dashboard-agent feature flag here, the email transport below.
 *
 * No plan check: billing gates this separately, later. The `organizationId` stays
 * in the signature so that gate can be re-attached here without touching callers.
 */
export async function canUseDashboardAgentAlerts(params: {
  userId: string;
  organizationSlug: string;
  organizationId: string;
  isAdmin?: boolean;
  orgFeatureFlags?: Record<string, unknown> | null;
}): Promise<DashboardAgentAlertGate> {
  const hasAgent = await canAccessDashboardAgent({
    userId: params.userId,
    isAdmin: params.isAdmin ?? false,
    // Never an impersonated session: this runs in the background, or for the
    // agent acting as the user.
    isImpersonating: false,
    organizationSlug: params.organizationSlug,
    orgFeatureFlags: params.orgFeatureFlags,
  });
  if (!hasAgent) return { allowed: false, reason: "dashboard_agent_disabled" };

  return { allowed: true };
}

/**
 * The same gate for *creating* an email subscription: the installation also needs
 * an email transport, or the channel would be created and never deliver.
 */
export async function canUseDashboardAgentEmailAlerts(
  params: Parameters<typeof canUseDashboardAgentAlerts>[0] & { projectId: string }
): Promise<DashboardAgentAlertGate> {
  const base = await canUseDashboardAgentAlerts(params);
  if (!base.allowed) return base;

  // Mirrors what the alerts email client needs: a from-address and ANY
  // configured transport (resend, smtp, aws-ses) — not resend specifically.
  if (env.ALERT_FROM_EMAIL === undefined || env.ALERT_EMAIL_TRANSPORT === undefined) {
    return { allowed: false, reason: "email_alerts_not_configured" };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Unsubscribe.
// ---------------------------------------------------------------------------

export type UnsubscribeResult =
  | { ok: true; channelName: string; disabledChannel: boolean }
  | { ok: false; reason: "not_found" | "conflict" };

/** How many times a lost race is retried before the caller is told to try again. */
const UNSUBSCRIBE_ATTEMPTS = 3;

/**
 * Take `DASHBOARD_AGENT_WATCH` off a channel — what both the email's one-click
 * link and the agent's DELETE endpoint do.
 *
 * A channel that subscribed to nothing else is disabled rather than left with an
 * empty `alertTypes`: an empty subscription list is a channel that silently
 * receives nothing, which reads as a bug on the Alerts page.
 *
 * Removing one entry from a list can't be expressed as a blind update, so the
 * write is conditional on the list the read saw. Anyone editing the channel's
 * other subscriptions concurrently makes this attempt fail rather than clobber
 * them, and it retries against the new list.
 */
export async function unsubscribeChannelFromWatchAlerts(
  channelId: string,
  options: { projectId?: string } = {},
  db: PrismaClientOrTransaction = prisma
): Promise<UnsubscribeResult> {
  const scope = { id: channelId, ...(options.projectId ? { projectId: options.projectId } : {}) };

  for (let attempt = 0; attempt < UNSUBSCRIBE_ATTEMPTS; attempt++) {
    const channel = await db.projectAlertChannel.findFirst({
      where: scope,
      select: { name: true, alertTypes: true },
    });
    if (!channel) return { ok: false, reason: "not_found" };

    const remaining = channel.alertTypes.filter(
      (type) => type !== DASHBOARD_AGENT_WATCH_ALERT_TYPE
    );

    const { count } = await db.projectAlertChannel.updateMany({
      // `alertTypes` here is the compare-and-swap: the row must still hold the
      // exact list this attempt read.
      where: { ...scope, alertTypes: { equals: channel.alertTypes } },
      data: {
        alertTypes: remaining,
        ...(remaining.length === 0 ? { enabled: false } : {}),
      },
    });

    if (count > 0) {
      return { ok: true, channelName: channel.name, disabledChannel: remaining.length === 0 };
    }
  }

  return { ok: false, reason: "conflict" };
}
