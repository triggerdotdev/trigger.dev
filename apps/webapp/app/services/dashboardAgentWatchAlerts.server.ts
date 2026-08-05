/**
 * The seam between a watch firing and the standard alert pipeline. A fired watch
 * already wakes its chat; this is the other delivery, to the project's configured
 * channels that subscribe to `DASHBOARD_AGENT_WATCH`.
 *
 * Two things live here: the enqueue, and the gate both the fan-out and the agent's
 * subscribe endpoint consult.
 */

import { type Watch } from "@internal/dashboard-agent-db";
import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { alertsWorker } from "~/v3/alertsWorker.server";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";
import { CreateAlertChannelService } from "~/v3/services/alerts/createAlertChannel.server";

/** The alert type a watch fires under. */
export const DASHBOARD_AGENT_WATCH_ALERT_TYPE = "DASHBOARD_AGENT_WATCH" as const;

/**
 * What the enqueue needs off a watch row. A shape rather than the full row, so both
 * the fired callback and the fire-at-creation path can hand one in.
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
 * Only `fired` dispatches. An expiry is a chat-level non-event that the agent narrates
 * in the conversation, and mailing it would train people to ignore watch alerts. The
 * outcome stays in the signature so callers read the same either way.
 *
 * The job id carries the idempotency: one fan-out job per watch, so a retried
 * callback, a redelivering tick and the creation path racing the watcher collapse into
 * a single alert. The fan-out then enqueues one job per channel, keyed per channel.
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
      // The frozen resolved result: the email renders from these and never re-reads the
      // source. A fired watch is condition_met by construction.
      resolution: watch.resolution ?? "condition_met",
      observed: watch.observedOutcome ?? undefined,
    },
  });
}

export type DashboardAgentAlertDenyReason =
  /** The user can't use the dashboard agent, so its watches can't alert either. */
  | "dashboard_agent_disabled"
  /** This installation has no alert email transport configured. */
  | "email_alerts_not_configured";

export type DashboardAgentAlertGate =
  | { allowed: true }
  | { allowed: false; reason: DashboardAgentAlertDenyReason };

/**
 * May this user's watches alert at all? Operational checks only: the dashboard-agent
 * feature flag here, the email transport below.
 *
 * No plan check, because billing gates this separately. `organizationId` stays in the
 * signature so that gate can be re-attached without touching callers.
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
    // Never an impersonated session: this runs in the background, or for the agent
    // acting as the user.
    isImpersonating: false,
    organizationSlug: params.organizationSlug,
    orgFeatureFlags: params.orgFeatureFlags,
  });
  if (!hasAgent) return { allowed: false, reason: "dashboard_agent_disabled" };

  return { allowed: true };
}

/**
 * Whether a fired watch in this environment would already reach the user outside the
 * chat, so the agent knows whether to offer an email alert:
 *
 * - `subscribed`: an enabled channel of any type already subscribes to watch fires.
 * - `unavailable`: the plan or feature gate denies alerts, so don't advertise it.
 * - `none`: alerts are possible and nothing is subscribed yet.
 *
 * Advisory only. This annotates a watch that is already created, so every failure is
 * the quiet `none` and never turns into a failed creation.
 */
export async function resolveWatchEmailAlertsState(params: {
  userId: string;
  environment: AuthenticatedEnvironment;
}): Promise<"subscribed" | "none" | "unavailable"> {
  const { userId, environment } = params;
  try {
    // The same predicate the delivery job selects channels with, so "subscribed"
    // means a fire would actually be delivered.
    const channel = await $replica.projectAlertChannel.findFirst({
      where: {
        projectId: environment.project.id,
        enabled: true,
        alertTypes: { has: DASHBOARD_AGENT_WATCH_ALERT_TYPE },
        environmentTypes: { has: environment.type },
      },
      select: { id: true },
    });
    if (channel) return "subscribed";

    const gate = await canUseDashboardAgentAlerts({
      userId,
      organizationId: environment.organizationId,
      organizationSlug: environment.organization.slug,
      orgFeatureFlags: environment.organization.featureFlags as Record<string, unknown> | null,
    });
    return gate.allowed ? "none" : "unavailable";
  } catch (error) {
    logger.error("Failed to resolve dashboard agent watch alert state", {
      error,
      userId,
      organizationId: environment.organizationId,
      projectId: environment.project.id,
      environmentId: environment.id,
    });
    return "none";
  }
}

/**
 * The same gate for creating an email subscription: the installation also needs an
 * email transport, or the channel would be created and never deliver.
 */
export async function canUseDashboardAgentEmailAlerts(
  params: Parameters<typeof canUseDashboardAgentAlerts>[0] & { projectId: string }
): Promise<DashboardAgentAlertGate> {
  const base = await canUseDashboardAgentAlerts(params);
  if (!base.allowed) return base;

  // Mirrors what the alerts email client needs: a from-address and any configured
  // transport, not resend specifically.
  if (env.ALERT_FROM_EMAIL === undefined || env.ALERT_EMAIL_TRANSPORT === undefined) {
    return { allowed: false, reason: "email_alerts_not_configured" };
  }

  return { allowed: true };
}

export type SubscribeToWatchAlertsResult =
  | { ok: true; email: string }
  | { ok: false; reason: DashboardAgentAlertDenyReason | "user_not_found" };

/**
 * Subscribe the signed-in user's own account email to this project's watch alerts.
 *
 * Always the caller's own email, read off the primary. The address is never taken from
 * the request, so this path cannot be used to mail a watch to someone else. The
 * deduplication key is stable per (email, project), so opting in twice re-enables the
 * existing subscription rather than stacking channels, and it stays cancellable on the
 * Alerts page.
 *
 * Advisory by design: the caller creates the watch first and treats a refusal here as
 * "no external delivery", never as a failed watch.
 */
export async function subscribeUserToWatchAlerts(params: {
  userId: string;
  environment: {
    type: string;
    organizationId: string;
    organization: { slug: string };
    project: { id: string; externalRef: string };
  };
}): Promise<SubscribeToWatchAlertsResult> {
  const { userId, environment } = params;

  const gate = await canUseDashboardAgentEmailAlerts({
    userId,
    organizationId: environment.organizationId,
    organizationSlug: environment.organization.slug,
    projectId: environment.project.id,
  });
  if (!gate.allowed) return { ok: false, reason: gate.reason };

  const user = await prisma.user.findFirst({ where: { id: userId }, select: { email: true } });
  if (!user) return { ok: false, reason: "user_not_found" };

  const service = new CreateAlertChannelService();
  await service.call(environment.project.externalRef, userId, {
    name: `Watch alerts for ${user.email}`,
    alertTypes: [DASHBOARD_AGENT_WATCH_ALERT_TYPE],
    environmentTypes: [environment.type as never],
    deduplicationKey: `dashboard-agent-watch:${user.email}`,
    channel: { type: "EMAIL", email: user.email },
  });

  return { ok: true, email: user.email };
}

export type UnsubscribeResult =
  | { ok: true; channelName: string; disabledChannel: boolean }
  | { ok: false; reason: "not_found" | "conflict" };

/** How many times a lost race is retried before the caller is told to try again. */
const UNSUBSCRIBE_ATTEMPTS = 3;

/**
 * Take `DASHBOARD_AGENT_WATCH` off a channel, for both the email's one-click link and
 * the agent's DELETE endpoint.
 *
 * A channel that subscribed to nothing else is disabled rather than left with an empty
 * `alertTypes`, which would read as a bug on the Alerts page.
 *
 * Removing one entry from a list can't be a blind update, so the write is conditional
 * on the list the read saw. A concurrent edit to the channel's other subscriptions
 * fails this attempt rather than clobbering them, and it retries against the new list.
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
      // The compare-and-swap: the row must still hold the exact list this attempt read.
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
