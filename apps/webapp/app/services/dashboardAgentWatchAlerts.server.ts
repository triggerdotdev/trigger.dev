/**
 * The seam between a watch firing and the standard alert pipeline: the enqueue, plus the
 * gate both the fan-out and the agent's subscribe endpoint consult.
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

/** What the enqueue needs off a watch row, rather than the full row. */
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
 * Queue the alert fan-out for a resolved watch. Only `fired` dispatches; an expiry is
 * narrated in the chat. The job id is the idempotency key: one fan-out per watch.
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
      // The frozen resolved result: the email renders from these and never re-reads
      // the source.
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
 * May this user's watches alert at all? Operational checks only, no plan check: billing
 * gates that separately. `organizationId` stays in the signature for that gate.
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
    // Never an impersonated session: this runs in the background.
    isImpersonating: false,
    organizationSlug: params.organizationSlug,
    orgFeatureFlags: params.orgFeatureFlags,
  });
  if (!hasAgent) return { allowed: false, reason: "dashboard_agent_disabled" };

  return { allowed: true };
}

/**
 * Whether a fired watch in this environment would already reach the user outside the
 * chat. Advisory only: the watch already exists, so every failure answers `none`.
 */
export async function resolveWatchEmailAlertsState(params: {
  userId: string;
  environment: AuthenticatedEnvironment;
}): Promise<"subscribed" | "none" | "unavailable"> {
  const { userId, environment } = params;
  try {
    // The same predicate the delivery job selects channels with.
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

/** The same gate plus an email transport, or the channel would never deliver. */
export async function canUseDashboardAgentEmailAlerts(
  params: Parameters<typeof canUseDashboardAgentAlerts>[0] & { projectId: string }
): Promise<DashboardAgentAlertGate> {
  const base = await canUseDashboardAgentAlerts(params);
  if (!base.allowed) return base;

  // Mirrors what the alerts email client needs, not resend specifically.
  if (env.ALERT_FROM_EMAIL === undefined || env.ALERT_EMAIL_TRANSPORT === undefined) {
    return { allowed: false, reason: "email_alerts_not_configured" };
  }

  return { allowed: true };
}

// A channel has no owner column, so this key is the only record of whose channel it is.
export function watchAlertDeduplicationKey(email: string): string {
  return `dashboard-agent-watch:${email}`;
}

export type SubscribeToWatchAlertsResult =
  | { ok: true; email: string }
  | { ok: false; reason: DashboardAgentAlertDenyReason | "user_not_found" };

/**
 * Subscribe the signed-in user's own account email to this project's watch alerts. The
 * address is never taken from the request, and the dedup key is stable per (email, project).
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
    deduplicationKey: watchAlertDeduplicationKey(user.email),
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
 * Take `DASHBOARD_AGENT_WATCH` off a channel, disabling one left with no alert types. The
 * write is conditional on the list the read saw, so a concurrent edit fails this attempt.
 *
 * A project is shared by every member, so a request-driven caller must pass
 * `organizationId` and `ownerUserId` too.
 */
export async function unsubscribeChannelFromWatchAlerts(
  channelId: string,
  options: { projectId?: string; organizationId?: string; ownerUserId?: string } = {},
  db: PrismaClientOrTransaction = prisma
): Promise<UnsubscribeResult> {
  let ownerKey: string | undefined;
  if (options.ownerUserId) {
    const owner = await db.user.findFirst({
      where: { id: options.ownerUserId },
      select: { email: true },
    });
    if (!owner) return { ok: false, reason: "not_found" };
    ownerKey = watchAlertDeduplicationKey(owner.email);
  }

  const scope = {
    id: channelId,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.organizationId ? { project: { organizationId: options.organizationId } } : {}),
    ...(ownerKey ? { deduplicationKey: ownerKey } : {}),
  };

  for (let attempt = 0; attempt < UNSUBSCRIBE_ATTEMPTS; attempt++) {
    const channel = await db.projectAlertChannel.findFirst({
      where: scope,
      select: { name: true, alertTypes: true, projectId: true, deduplicationKey: true },
    });
    // A channel this alert type was never on is out of scope: stripping nothing off it
    // would still report success, and an empty list would disable it.
    if (!channel || !channel.alertTypes.includes(DASHBOARD_AGENT_WATCH_ALERT_TYPE)) {
      return { ok: false, reason: "not_found" };
    }

    const remaining = channel.alertTypes.filter(
      (type) => type !== DASHBOARD_AGENT_WATCH_ALERT_TYPE
    );

    const { count } = await db.projectAlertChannel.updateMany({
      // Compare-and-swap on the row the scoped read returned. `updateMany` takes no relation
      // filter, so the org scope is carried by the read's `projectId`.
      where: {
        id: channelId,
        projectId: channel.projectId,
        deduplicationKey: channel.deduplicationKey,
        alertTypes: { equals: channel.alertTypes },
      },
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
