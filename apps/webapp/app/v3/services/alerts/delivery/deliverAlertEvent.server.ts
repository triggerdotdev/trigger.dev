import type { ChatPostMessageArguments, ChatPostMessageResponse } from "@slack/web-api";
import type { OrganizationIntegrationForService } from "~/models/orgIntegration.server";
import {
  type DashboardAgentDb,
  appendChatMessageOnceByChatId,
  chatExists,
} from "@internal/dashboard-agent-db";
import {
  type Alert,
  type AlertEvent,
  claimDelivery,
  DELIVERY_RETRIES_EXHAUSTED,
  failExhaustedDelivery,
  type DeliveryRetryCap,
  getAlert,
  getAlertEvent,
  isDeliveryExhausted,
  listClaimableDeliveriesForEvent,
  markDelivered,
  markDeliveryFailed,
  releaseDelivery,
} from "../storage/alertStore.server";
import type { UIMessage } from "ai";
import assertNever from "assert-never";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { environmentTitle } from "~/components/environments/EnvironmentLabel";
import {
  ProjectAlertEmailProperties,
  ProjectAlertSlackProperties,
  ProjectAlertWebhookProperties,
} from "~/models/projectAlert.server";
import { ApiErrorGroupPresenter } from "~/presenters/v3/ApiErrorGroupPresenter.server";
import { sendAlertEmail } from "~/services/email.server";
import { logger } from "~/services/logger.server";
import { alertOccurrenceDetail, occurrenceFingerprint } from "emails/src/alertRaisedContent";
import { v3AlertPath, v3ErrorPath } from "~/utils/pathBuilder";
import { alertsRateLimiter } from "~/v3/alertsRateLimiter.server";
import { isOrganizationAlertsEnabled } from "~/v3/canUseAlertsList.server";
import {
  SkipRetryError,
  findSlackIntegration as defaultFindSlackIntegration,
  postSlackMessage as defaultPostSlackMessage,
  deliverWebhookPayload as defaultDeliverWebhookPayload,
} from "../alertTransport.server";
import { buildAlertSlackMessage } from "./alertSlackMessage";
import { alertEventChatText } from "./alertEventChatText";

const WEBHOOK_VERSION = "2026-09-17";
const STALE_CLAIM_MS = 5 * 60 * 1000;

type SendSlackMessageFn = (
  integration: OrganizationIntegrationForService<"SLACK">,
  message: ChatPostMessageArguments
) => Promise<ChatPostMessageResponse>;

type DeliverWebhookFn = (params: {
  url: string;
  secret: ProjectAlertWebhookProperties["secret"];
  rawPayload: string;
  context?: { webhookId?: string };
}) => Promise<Response>;

type SendAlertEmailFn = (data: Parameters<typeof sendAlertEmail>[0]) => Promise<void>;

type FindSlackIntegrationFn = typeof defaultFindSlackIntegration;

type FindChannelFn = (params: { id: string; projectId: string }) => Promise<ChannelInfo | null>;

type CheckRateLimitFn = (channelId: string) => Promise<{ allowed: boolean } | null>;

type AlertContext = {
  organization: { slug: string; title: string };
  project: { slug: string; name: string };
  environment: { slug: string; name: string };
};

type LoadAlertContextFn = (alert: Alert) => Promise<AlertContext | null>;

type LoadErrorTitleFn = (alert: Alert, fingerprint: string) => Promise<string | null>;

type ChatWakeResult = "appended" | "duplicate" | "not_found";

type DeliverChatWakeFn = (params: {
  chatId: string;
  actionId: string;
  alert: Alert;
  event: AlertEvent;
  errorTitle?: string | null;
}) => Promise<ChatWakeResult>;

type VerifyChatForAlertFn = (params: {
  chatId: string;
  alert: Alert;
  userId?: string;
}) => Promise<boolean>;

export type DeliverAlertEventDeps = {
  db: PrismaClientOrTransaction;
  chatDb?: DashboardAgentDb;
  sendSlackMessage?: SendSlackMessageFn;
  deliverWebhook?: DeliverWebhookFn;
  sendEmail?: SendAlertEmailFn;
  findSlackIntegration?: FindSlackIntegrationFn;
  findChannel?: FindChannelFn;
  checkRateLimit?: CheckRateLimitFn;
  deliverChatWake?: DeliverChatWakeFn;
  verifyChatForAlert?: VerifyChatForAlertFn;
  loadAlertContext?: LoadAlertContextFn;
  loadErrorTitle?: LoadErrorTitleFn;
  isOrganizationEnabled?: (organizationId: string) => Promise<boolean>;
  retryCap?: DeliveryRetryCap;
};

type ChannelInfo = {
  id: string;
  type: "EMAIL" | "SLACK" | "WEBHOOK";
  enabled: boolean;
  properties: unknown;
  projectId: string;
};

export function alertDeliveryRetryCap(): DeliveryRetryCap {
  return {
    maxAttempts: env.ALERT_DELIVERY_MAX_ATTEMPTS,
    maxAgeMs: env.ALERT_DELIVERY_MAX_AGE_HOURS * 60 * 60 * 1000,
  };
}

function renderFacts(facts: Record<string, unknown>): Array<{ label: string; value: string }> {
  return Object.entries(facts)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, 12)
    .map(([key, value]) => ({
      label: humanizeKey(key),
      value: typeof value === "object" ? JSON.stringify(value).slice(0, 200) : String(value),
    }));
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function alertDashboardLink(
  context: AlertContext,
  alertId: string,
  fingerprint: string | null
): string {
  if (fingerprint) {
    return `${env.APP_ORIGIN}${v3ErrorPath(
      context.organization,
      context.project,
      context.environment,
      { fingerprint }
    )}`;
  }
  return `${env.APP_ORIGIN}${v3AlertPath(
    context.organization,
    context.project,
    context.environment,
    alertId
  )}`;
}

export async function deliverAlertEvent(
  eventId: string,
  eventAt: Date,
  deps: DeliverAlertEventDeps
): Promise<void> {
  const { db } = deps;
  const sendSlack = deps.sendSlackMessage ?? defaultPostSlackMessage;
  const deliverWebhook =
    deps.deliverWebhook ??
    ((params) => defaultDeliverWebhookPayload({ ...params, encryptionKey: env.ENCRYPTION_KEY }));
  const sendEmail = deps.sendEmail ?? sendAlertEmail;
  const findSlack = deps.findSlackIntegration ?? defaultFindSlackIntegration;
  const findChannel: FindChannelFn =
    deps.findChannel ??
    (async (params) => {
      const ch = await prisma.projectAlertChannel.findFirst({
        where: { id: params.id, projectId: params.projectId },
        select: { id: true, type: true, enabled: true, properties: true, projectId: true },
      });
      return ch as ChannelInfo | null;
    });
  const checkRateLimit: CheckRateLimitFn =
    deps.checkRateLimit ?? ((channelId) => alertsRateLimiter.check(channelId).catch(() => null));
  const deliverChatWake: DeliverChatWakeFn =
    deps.deliverChatWake ?? defaultDeliverChatWake(deps.chatDb ?? dashboardAgentDb);
  const verifyChatForAlert: VerifyChatForAlertFn =
    deps.verifyChatForAlert ?? defaultVerifyChatForAlert(deps.chatDb ?? dashboardAgentDb);
  const loadAlertContext = deps.loadAlertContext ?? defaultLoadAlertContext;
  const loadErrorTitle = deps.loadErrorTitle ?? defaultLoadErrorTitle;
  const isOrganizationEnabled = deps.isOrganizationEnabled ?? isOrganizationAlertsEnabled;
  const retryCap = deps.retryCap ?? alertDeliveryRetryCap();

  const event = await getAlertEvent(db, { id: eventId, at: eventAt });

  if (!event) {
    logger.warn("[deliverAlertEvent] Event not found", { eventId });
    return;
  }

  const alert = await getAlert(db, { id: event.alertId });
  if (!alert) {
    logger.warn("[deliverAlertEvent] Alert not found", { alertId: event.alertId });
    return;
  }

  if (!(await isOrganizationEnabled(alert.organizationId))) {
    logger.debug("[deliverAlertEvent] Alerts disabled for organization", {
      organizationId: alert.organizationId,
      alertId: alert.id,
    });
    return;
  }

  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
  const claimableDeliveries = await listClaimableDeliveriesForEvent(
    db,
    eventId,
    eventAt,
    staleBefore
  );
  if (claimableDeliveries.length === 0) return;

  const retryableErrors: unknown[] = [];
  let contextPromise: Promise<AlertContext | null> | undefined;
  const getContext = () => (contextPromise ??= loadAlertContext(alert));
  const fingerprint = event.type === "raised" ? occurrenceFingerprint(event.facts) : null;
  let titlePromise: Promise<string | null> | undefined;
  const getErrorTitle = () =>
    fingerprint
      ? (titlePromise ??= loadErrorTitle(alert, fingerprint).catch(() => null))
      : Promise.resolve(null);

  for (const delivery of claimableDeliveries) {
    const claim = await claimDelivery(db, {
      id: delivery.id,
      eventAt,
      staleBefore,
      cap: retryCap,
    });
    if (!claim) {
      await failExhaustedDelivery(db, { id: delivery.id, eventAt, staleBefore, cap: retryCap });
      continue;
    }

    const { claimId } = claim;

    try {
      if (delivery.notifier.type === "chat") {
        const chatId = delivery.notifier.chatId;
        if (!chatId) {
          await markDeliveryFailed(db, {
            id: delivery.id,
            eventAt,
            claimId,
            reason: "chat_not_found",
          });
          continue;
        }

        const owned = await verifyChatForAlert({
          chatId,
          alert,
          userId: delivery.notifier.userId,
        });
        if (!owned) {
          await markDeliveryFailed(db, {
            id: delivery.id,
            eventAt,
            claimId,
            reason: "notifier_invalid",
          });
          continue;
        }

        const actionId = `alert:${event.id}`;
        const result = await deliverChatWake({
          chatId,
          actionId,
          alert,
          event,
          errorTitle: await getErrorTitle(),
        });
        if (result === "appended" || result === "duplicate") {
          await markDelivered(db, { id: delivery.id, eventAt, claimId });
        } else {
          await markDeliveryFailed(db, {
            id: delivery.id,
            eventAt,
            claimId,
            reason: "chat_not_found",
          });
        }
        continue;
      }

      const channel = await findChannel({
        id: delivery.notifier.channelId,
        projectId: alert.projectId,
      });

      if (!channel) {
        await markDeliveryFailed(db, {
          id: delivery.id,
          eventAt,
          claimId,
          reason: "notifier_deleted",
        });
        continue;
      }

      if (!channel.enabled) {
        await markDeliveryFailed(db, {
          id: delivery.id,
          eventAt,
          claimId,
          reason: "notifier_disabled",
        });
        continue;
      }

      const rateLimitResult = await checkRateLimit(channel.id);
      if (rateLimitResult && !rateLimitResult.allowed) {
        await releaseDelivery(db, { id: delivery.id, eventAt, claimId, refundAttempt: true });
        retryableErrors.push(new Error("rate_limited"));
        continue;
      }

      const facts = renderFacts(event.facts as Record<string, unknown>);
      const headline = alert.name ?? `Alert raised: ${alert.capabilityKey}`;

      const providerMetadata = await deliverToChannel({
        channel: channel as ChannelInfo,
        alert,
        event,
        facts,
        headline,
        getContext,
        getErrorTitle,
        sendSlack,
        deliverWebhook,
        sendEmail,
        findSlack,
      });

      await markDelivered(db, {
        id: delivery.id,
        eventAt,
        claimId,
        providerMetadata: providerMetadata ?? undefined,
      });
    } catch (error) {
      if (error instanceof SkipRetryError) {
        await markDeliveryFailed(db, {
          id: delivery.id,
          eventAt,
          claimId,
          reason: error.message,
        });
        continue;
      }

      if (isDeliveryExhausted(claim.delivery, retryCap, new Date())) {
        await markDeliveryFailed(db, {
          id: delivery.id,
          eventAt,
          claimId,
          reason: DELIVERY_RETRIES_EXHAUSTED,
        });
        logger.warn("[deliverAlertEvent] Delivery retries exhausted", {
          deliveryId: delivery.id,
          attempts: claim.delivery.attempts,
          error,
        });
        continue;
      }

      await releaseDelivery(db, { id: delivery.id, eventAt, claimId });
      retryableErrors.push(error);
    }
  }

  if (retryableErrors.length > 0) {
    throw new AggregateError(retryableErrors, `${retryableErrors.length} deliveries failed`);
  }
}

async function deliverToChannel(params: {
  channel: ChannelInfo;
  alert: Alert;
  event: AlertEvent;
  facts: Array<{ label: string; value: string }>;
  headline: string;
  getContext: () => Promise<AlertContext | null>;
  getErrorTitle: () => Promise<string | null>;
  sendSlack: SendSlackMessageFn;
  deliverWebhook: DeliverWebhookFn;
  sendEmail: SendAlertEmailFn;
  findSlack: FindSlackIntegrationFn;
}): Promise<Record<string, unknown> | null> {
  const {
    channel,
    alert,
    event,
    facts,
    headline,
    getContext,
    getErrorTitle,
    sendSlack,
    deliverWebhook,
    sendEmail,
    findSlack,
  } = params;

  switch (channel.type) {
    case "EMAIL":
      return deliverEmail({
        channel,
        alert,
        event,
        facts,
        headline,
        getContext,
        getErrorTitle,
        sendEmail,
      });
    case "SLACK":
      return deliverSlack({
        channel,
        alert,
        event,
        facts,
        headline,
        getContext,
        getErrorTitle,
        sendSlack,
        findSlack,
      });
    case "WEBHOOK":
      return deliverWebhookChannel({
        channel,
        alert,
        event,
        facts,
        headline,
        deliverWebhook,
      });
    default:
      assertNever(channel.type);
  }
}

async function deliverEmail(params: {
  channel: ChannelInfo;
  alert: Alert;
  event: AlertEvent;
  facts: Array<{ label: string; value: string }>;
  headline: string;
  getContext: () => Promise<AlertContext | null>;
  getErrorTitle: () => Promise<string | null>;
  sendEmail: SendAlertEmailFn;
}): Promise<null> {
  const emailProps = ProjectAlertEmailProperties.safeParse(params.channel.properties);
  if (!emailProps.success) throw new SkipRetryError("invalid_notifier_properties");

  const context = await params.getContext();
  if (!context) throw new SkipRetryError("environment_not_found");

  await params.sendEmail({
    email: "alert-raised",
    to: emailProps.data.email,
    alertName: params.alert.name ?? params.alert.capabilityKey,
    capabilityKey: params.alert.capabilityKey,
    headline: params.headline,
    raisedAt: params.event.at.toISOString(),
    detail: alertOccurrenceDetail(params.event.facts, await params.getErrorTitle()),
    facts: params.facts,
    dashboardLink: alertDashboardLink(
      context,
      params.alert.id,
      occurrenceFingerprint(params.event.facts)
    ),
    organization: context.organization.title,
    project: context.project.name,
    environment: context.environment.name,
  });

  return null;
}

async function deliverSlack(params: {
  channel: ChannelInfo;
  alert: Alert;
  event: AlertEvent;
  facts: Array<{ label: string; value: string }>;
  headline: string;
  getContext: () => Promise<AlertContext | null>;
  getErrorTitle: () => Promise<string | null>;
  sendSlack: SendSlackMessageFn;
  findSlack: FindSlackIntegrationFn;
}): Promise<Record<string, unknown> | null> {
  const slackProps = ProjectAlertSlackProperties.safeParse(params.channel.properties);
  if (!slackProps.success) throw new SkipRetryError("invalid_notifier_properties");

  const integration = await params.findSlack(prisma, {
    integrationId: slackProps.data.integrationId,
    organizationId: params.alert.organizationId,
  });

  if (!integration) {
    throw new SkipRetryError("Slack integration not found");
  }

  const context = await params.getContext();
  if (!context) throw new SkipRetryError("environment_not_found");

  const { text, blocks } = buildAlertSlackMessage({
    alertName: params.alert.name ?? params.alert.capabilityKey,
    headline: params.headline,
    project: context.project.name,
    environment: context.environment.name,
    raisedAt: params.event.at.toISOString(),
    detail: alertOccurrenceDetail(params.event.facts, await params.getErrorTitle()),
    dashboardLink: alertDashboardLink(
      context,
      params.alert.id,
      occurrenceFingerprint(params.event.facts)
    ),
  });

  const message = params.sendSlack(integration, {
    channel: slackProps.data.channelId,
    text,
    blocks,
  } as ChatPostMessageArguments);

  const result = await message;
  if (result.ts) {
    return { message_ts: result.ts };
  }
  return null;
}

async function deliverWebhookChannel(params: {
  channel: ChannelInfo;
  alert: Alert;
  event: AlertEvent;
  facts: Array<{ label: string; value: string }>;
  headline: string;
  deliverWebhook: DeliverWebhookFn;
}): Promise<null> {
  const webhookProps = ProjectAlertWebhookProperties.safeParse(params.channel.properties);
  if (!webhookProps.success) throw new SkipRetryError("invalid_notifier_properties");

  const rawPayload = JSON.stringify({
    id: `alert-event:${params.event.id}:channel:${params.channel.id}`,
    created: params.event.at,
    webhookVersion: WEBHOOK_VERSION,
    type: "alert.raised",
    object: {
      alert: {
        id: params.alert.id,
        name: params.alert.name,
        capabilityKey: params.alert.capabilityKey,
      },
      event: {
        id: params.event.id,
        type: params.event.type,
        at: params.event.at,
        facts: params.event.facts,
      },
      environment: { id: params.alert.environmentId },
      organization: { id: params.alert.organizationId },
      project: { id: params.alert.projectId },
    },
  });

  await params.deliverWebhook({
    url: webhookProps.data.url,
    secret: webhookProps.data.secret,
    rawPayload,
    context: { webhookId: params.channel.id },
  });

  return null;
}

function defaultDeliverChatWake(db: DashboardAgentDb): DeliverChatWakeFn {
  return async ({ chatId, actionId, alert, event, errorTitle }): Promise<ChatWakeResult> => {
    const appended = await appendChatMessageOnceByChatId(db, {
      chatId,
      message: {
        id: actionId,
        role: "assistant",
        parts: [{ type: "text", text: alertEventChatText(event, alert, errorTitle) }],
      } satisfies Pick<UIMessage, "id" | "role" | "parts">,
    });
    if (appended) return "appended";
    const existing = await db.query.chatMessages.findFirst({
      where: (t, { eq: e, and: a }) => a(e(t.chatId, chatId), e(t.messageId, actionId)),
      columns: { messageId: true },
    });
    return existing ? "duplicate" : "not_found";
  };
}

async function defaultLoadAlertContext(alert: Alert): Promise<AlertContext | null> {
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: alert.environmentId,
      projectId: alert.projectId,
      project: { organizationId: alert.organizationId },
    },
    select: {
      slug: true,
      type: true,
      branchName: true,
      project: {
        select: { slug: true, name: true, organization: { select: { slug: true, title: true } } },
      },
    },
  });
  if (!environment) return null;
  return {
    organization: environment.project.organization,
    project: { slug: environment.project.slug, name: environment.project.name },
    environment: { slug: environment.slug, name: environmentTitle(environment) },
  };
}

const MAX_ERROR_TITLE = 120;

const defaultLoadErrorTitle: LoadErrorTitleFn = async (alert, fingerprint) => {
  const group = await new ApiErrorGroupPresenter().call(
    alert.organizationId,
    alert.projectId,
    alert.environmentId,
    fingerprint
  );
  if (!group) return null;
  const title = `${group.errorType}: ${group.errorMessage}`.replace(/\s+/g, " ").trim();
  return title.length > MAX_ERROR_TITLE ? `${title.slice(0, MAX_ERROR_TITLE - 1)}…` : title;
};

function defaultVerifyChatForAlert(db: DashboardAgentDb): VerifyChatForAlertFn {
  return async ({ chatId, alert, userId }) => {
    return chatExists(db, {
      chatId,
      organizationId: alert.organizationId,
      userId: userId ?? alert.createdBy,
    });
  };
}
