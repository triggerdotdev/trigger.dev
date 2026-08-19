/**
 * The seam between a watch firing and the standard alert pipeline: the enqueue, plus the
 * gate both the fan-out and the agent's subscribe endpoint consult.
 */

import { type Watch } from "@internal/dashboard-agent-db";
import {
  type PrismaClientOrTransaction,
  type ProjectAlertChannel,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
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

type DashboardAgentAlertDenyReason =
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
  orgFeatureFlags?: Record<string, unknown> | null;
}): Promise<DashboardAgentAlertGate> {
  const hasAgent = await canAccessDashboardAgent({
    // `isAdmin` is left out on purpose: there is no session here, so the gate reads it off
    // the user row and a watch an admin could create can still alert.
    userId: params.userId,
    // Never an impersonated session: this runs in the background.
    isImpersonating: false,
    organizationSlug: params.organizationSlug,
    orgFeatureFlags: params.orgFeatureFlags,
  });
  if (!hasAgent) return { allowed: false, reason: "dashboard_agent_disabled" };

  return { allowed: true };
}

/**
 * Whether a fired watch in this environment would already reach this user outside the
 * chat. Advisory only: the watch already exists, so every failure answers `none`.
 */
export async function resolveWatchEmailAlertsState(params: {
  userId: string;
  environment: AuthenticatedEnvironment;
}): Promise<"subscribed" | "none" | "unavailable"> {
  const { userId, environment } = params;
  try {
    // Another member's channel mails them, not this user, so only this user's own channel
    // answers "subscribed".
    const owner = await resolveWatchAlertOwnership(userId, $replica);
    const channel = owner
      ? await $replica.projectAlertChannel.findFirst({
          where: {
            projectId: environment.project.id,
            deduplicationKey: owner.deduplicationKey,
            enabled: true,
            alertTypes: { has: DASHBOARD_AGENT_WATCH_ALERT_TYPE },
            environmentTypes: { has: environment.type },
          },
          select: { id: true },
        })
      : null;
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

/**
 * The one place a user id becomes watch-alert ownership. Reading state, subscribing and
 * unsubscribing all go through here, so they cannot disagree about whose channel is whose.
 */
async function resolveWatchAlertOwnership(
  userId: string,
  db: PrismaClientOrTransaction = prisma
): Promise<{ email: string; deduplicationKey: string } | undefined> {
  const user = await db.user.findFirst({ where: { id: userId }, select: { email: true } });
  if (!user) return undefined;
  return { email: user.email, deduplicationKey: watchAlertDeduplicationKey(user.email) };
}

/** How many times a lost race is retried before the subscribe is reported as failed. */
const SUBSCRIBE_ATTEMPTS = 3;

function withoutDuplicates<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list : [...list, value];
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002"
  );
}

/**
 * Put this environment type on the user's watch-alert channel, creating the channel if there
 * is none. One channel per (email, project), so subscribing in a second environment must add
 * to the list rather than replace it — replacing silently stops the first one's mail.
 *
 * The update is conditional on the lists the read saw, so two environments subscribing at
 * once cannot drop each other's addition: the loser sees no updated row and reads again.
 */
export async function subscribeChannelToWatchAlerts(params: {
  userId: string;
  email: string;
  deduplicationKey: string;
  environmentType: RuntimeEnvironmentType;
  project: { id: string; externalRef: string };
}): Promise<Pick<ProjectAlertChannel, "id" | "type" | "enabled" | "environmentTypes">> {
  const { userId, email, deduplicationKey, environmentType, project } = params;
  const name = `Watch alerts for ${email}`;

  for (let attempt = 0; attempt < SUBSCRIBE_ATTEMPTS; attempt++) {
    const existing = await prisma.projectAlertChannel.findFirst({
      where: { projectId: project.id, deduplicationKey },
      select: { id: true, alertTypes: true, environmentTypes: true },
    });

    if (!existing) {
      try {
        // The service also checks this user's membership of the project.
        return await new CreateAlertChannelService().call(project.externalRef, userId, {
          name,
          alertTypes: [DASHBOARD_AGENT_WATCH_ALERT_TYPE],
          environmentTypes: [environmentType],
          deduplicationKey,
          channel: { type: "EMAIL", email },
        });
      } catch (error) {
        // Another environment created the channel first; the next attempt adds onto it.
        if (!isUniqueConstraintError(error)) throw error;
        continue;
      }
    }

    const environmentTypes = withoutDuplicates(existing.environmentTypes, environmentType);
    const alertTypes = withoutDuplicates(existing.alertTypes, DASHBOARD_AGENT_WATCH_ALERT_TYPE);

    const { count } = await prisma.projectAlertChannel.updateMany({
      // Compare-and-swap on the lists the read returned.
      where: {
        id: existing.id,
        projectId: project.id,
        deduplicationKey,
        environmentTypes: { equals: existing.environmentTypes },
        alertTypes: { equals: existing.alertTypes },
      },
      data: {
        name,
        alertTypes,
        environmentTypes,
        type: "EMAIL",
        properties: { email },
        enabled: true,
      },
    });

    if (count > 0) {
      return { id: existing.id, type: "EMAIL", enabled: true, environmentTypes };
    }
  }

  throw new Error("Could not subscribe to watch alerts: the channel kept changing underneath");
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

  const owner = await resolveWatchAlertOwnership(userId);
  if (!owner) return { ok: false, reason: "user_not_found" };

  await subscribeChannelToWatchAlerts({
    userId,
    email: owner.email,
    deduplicationKey: owner.deduplicationKey,
    environmentType: environment.type as RuntimeEnvironmentType,
    project: environment.project,
  });

  return { ok: true, email: owner.email };
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
    const owner = await resolveWatchAlertOwnership(options.ownerUserId, db);
    if (!owner) return { ok: false, reason: "not_found" };
    ownerKey = owner.deduplicationKey;
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
