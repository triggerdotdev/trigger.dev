import { fenceUntrusted } from "../../gate/fence.server";
import type { McpToolResult } from "../../gate/withMcpToolAuth.server";
import { capText } from "./logFields";

type AlertCapabilityParam = {
  key: string;
  label: string;
  unit?: string;
  default: number;
  min?: number;
  max?: number;
};

export type AlertCapability = {
  key: string;
  title: string;
  unit?: string;
  area: string;
  allowedKinds: string[];
  allowedScopes: string[];
  params?: AlertCapabilityParam[];
};

export function formatCapabilityLine(capability: AlertCapability): string {
  const unit = capability.unit ? ` (${capability.unit})` : "";
  const params = capability.params?.length
    ? ` — params: ${capability.params
        .map((param) => {
          const paramUnit = param.unit ? ` ${param.unit}` : "";
          const range =
            param.min !== undefined || param.max !== undefined
              ? ` [${param.min ?? "-"}, ${param.max ?? "-"}]`
              : "";
          return `${param.key} (${param.label}, default=${param.default}${paramUnit}${range})`;
        })
        .join(", ")}`
    : "";
  return `- ${capability.key}: ${capability.title}${unit} — area=${capability.area}, kinds=${capability.allowedKinds.join(", ")}, scopes=${capability.allowedScopes.join(", ")}${params}`;
}

export function formatAlertLine(alert: {
  id: string;
  name: string | null;
  capabilityKey: string;
  lifecycle: string;
  attention: string;
}): string {
  const name = alert.name ? fenceCapped(alert.name, "alert-name") : "(unnamed)";
  return `- ${name} (id=${alert.id}) capability=${alert.capabilityKey} lifecycle=${alert.lifecycle} attention=${alert.attention}`;
}

/** Alert tool errors as plain text, the same form the confirmation gate uses for a refusal. */
export const alertError = (text: string): McpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export function formatAlertList(lines: string[], limit: number): string {
  if (lines.length === 0) return "No monitoring alerts found.";
  return [
    `Showing ${lines.length} monitoring alert${lines.length === 1 ? "" : "s"}, those needing attention first, then newest first.`,
    ...(lines.length >= limit ? [`Stopped at the limit of ${limit}; more alerts may exist.`] : []),
    ...lines,
  ].join("\n");
}

const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;

export const MAX_ALERT_EVENTS = 20;
export const MAX_ALERT_MEMBERS = 50;
export const MAX_ALERT_CHANNELS = 50;
export const MAX_ALERT_NOTIFIERS = 50;
const MAX_TEXT = 200;
const MAX_QUERY = 2000;

const fenceCapped = (text: string, source: string, max = MAX_TEXT) =>
  fenceUntrusted(capText(text, max), source);

const plainToken = (value: string, source: string) =>
  TOKEN.test(value) ? value : fenceCapped(value, source, 128);

export const alertLabel = (alert: { id: string; name: string }) =>
  `${fenceCapped(alert.name, "alert-name")} (id=${plainToken(alert.id, "alert-id")})`;

export type AlertDetailView = {
  id: string;
  name: string;
  capabilityKey: string;
  area: string;
  status: { status: string; reason?: string };
  conditionSummary: string;
  scopeSummary: string;
  compiledQuery?: string;
  expiresAt: Date | null;
  resolvedByLabel: string | null;
  stoppedByLabel: string | null;
  notifiers: { key: string; label: string }[];
  chatNotifierCount?: number;
  channelIssues: { channelId: string; reason: string }[];
  occurrenceCount: number;
  firstEventAt?: Date;
  lastEventAt?: Date;
  events: {
    type: string;
    at: Date;
    factsSummary: string;
    taskIdentifier?: string;
    fingerprint?: string;
  }[];
};

export function formatAlertDetail(
  alert: AlertDetailView,
  group?: { total: number; members: { id: string; name: string }[] }
): string {
  const status = plainToken(alert.status.status, "alert-status");
  const reason = alert.status.reason ? ` (${plainToken(alert.status.reason, "alert-status")})` : "";
  const lines = [
    `Alert ${fenceCapped(alert.name, "alert-name")} (id=${plainToken(alert.id, "alert-id")})`,
    `Capability: ${plainToken(alert.capabilityKey, "alert-capability")} · area=${plainToken(alert.area, "alert-area")}`,
    `Status: ${status}${reason}`,
    `Condition: ${fenceCapped(alert.conditionSummary, "alert-condition")}`,
    `Scope: ${fenceCapped(alert.scopeSummary, "alert-scope")}`,
  ];
  if (alert.compiledQuery) {
    lines.push(`Query: ${fenceCapped(alert.compiledQuery, "alert-query", MAX_QUERY)}`);
  }
  lines.push(`Expires: ${alert.expiresAt ? alert.expiresAt.toISOString() : "never"}`);
  if (alert.resolvedByLabel && alert.status.status !== "needs_attention") {
    lines.push(`Resolved by: ${fenceCapped(alert.resolvedByLabel, "alert-member")}`);
  }
  if (alert.stoppedByLabel) {
    lines.push(`Stopped by: ${fenceCapped(alert.stoppedByLabel, "alert-member")}`);
  }

  const chatNotifiers = Math.min(alert.chatNotifierCount ?? 0, MAX_ALERT_NOTIFIERS);
  lines.push(alert.notifiers.length + chatNotifiers > 0 ? "Notifiers:" : "Notifiers: none");
  const notifiers = alert.notifiers.slice(0, MAX_ALERT_NOTIFIERS);
  for (const notifier of notifiers) {
    lines.push(
      `- ${fenceCapped(notifier.label, "alert-channel-name")} (${plainToken(notifier.key, "alert-notifier")})`
    );
  }
  if (alert.notifiers.length > notifiers.length) {
    lines.push(`Showing ${notifiers.length} of ${alert.notifiers.length} notifiers.`);
  }
  for (let i = 0; i < chatNotifiers; i++) lines.push("- a chat notifier");
  const issues = alert.channelIssues.slice(0, MAX_ALERT_NOTIFIERS);
  for (const issue of issues) {
    lines.push(
      `- channel ${plainToken(issue.channelId, "alert-channel-id")} cannot deliver: ${plainToken(issue.reason, "alert-channel-issue")}`
    );
  }
  if (alert.channelIssues.length > issues.length) {
    lines.push(`Showing ${issues.length} of ${alert.channelIssues.length} channel issues.`);
  }

  if (group) {
    lines.push(`Group members: ${group.total}`);
    for (const member of group.members) {
      lines.push(
        `- ${fenceCapped(member.name, "alert-name")} (id=${plainToken(member.id, "alert-id")})`
      );
    }
    if (group.total > group.members.length) {
      lines.push(`Showing ${group.members.length} of ${group.total} members.`);
    }
  }

  lines.push(
    `Raised ${alert.occurrenceCount} times` +
      (alert.firstEventAt ? ` · first event ${alert.firstEventAt.toISOString()}` : "") +
      (alert.lastEventAt ? ` · last event ${alert.lastEventAt.toISOString()}` : "")
  );
  const events = alert.events.slice(0, MAX_ALERT_EVENTS);
  lines.push(events.length > 0 ? "Recent activity (newest first):" : "Recent activity: none");
  for (const event of events) {
    const parts = [`- ${event.at.toISOString()} ${plainToken(event.type, "alert-event-type")}`];
    if (event.factsSummary) parts.push(fenceCapped(event.factsSummary, "alert-event"));
    if (event.taskIdentifier) parts.push(`task ${fenceCapped(event.taskIdentifier, "alert-task")}`);
    if (event.fingerprint) parts.push(`error ${fenceCapped(event.fingerprint, "alert-error")}`);
    lines.push(parts.join(" · "));
  }
  if (alert.events.length > events.length) {
    lines.push(`Showing the ${events.length} most recent of ${alert.events.length} events loaded.`);
  }
  return lines.join("\n");
}

const HOSTNAME = /^(?:[a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}$|^\[[0-9a-f:.]{2,45}\]$/;

export function webhookHost(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.length <= 253 && HOSTNAME.test(hostname) ? hostname : "unknown host";
  } catch {
    return "unknown host";
  }
}

export type AlertChannelView = {
  id: string;
  friendlyId: string;
  name: string;
  type: string;
  enabled: boolean;
  alertTypes: string[];
  environmentTypes: string[];
  properties?:
    | { type: "WEBHOOK"; url: string }
    | { type: "EMAIL"; email: string }
    | { type: "SLACK"; channelName: string };
};

function channelTarget(properties: AlertChannelView["properties"]): string {
  switch (properties?.type) {
    case "WEBHOOK":
      return `host ${webhookHost(properties.url)}`;
    case "EMAIL":
      return `email ${fenceCapped(properties.email, "alert-channel-email")}`;
    case "SLACK":
      return `slack ${fenceCapped(properties.channelName, "alert-channel-slack")}`;
    default:
      return "no target";
  }
}

export function formatAlertChannelLine(channel: AlertChannelView): string {
  return [
    `- ${fenceCapped(channel.name, "alert-channel-name")} (channelId=${plainToken(channel.id, "alert-channel-id")}, friendlyId=${plainToken(channel.friendlyId, "alert-channel-id")})`,
    `type=${plainToken(channel.type, "alert-channel-type")}`,
    channel.enabled ? "enabled" : "disabled",
    `alertTypes=${channel.alertTypes.map((t) => plainToken(t, "alert-type")).join(",") || "none"}`,
    `environments=${channel.environmentTypes.map((t) => plainToken(t, "alert-env")).join(",") || "none"}`,
    channelTarget(channel.properties),
  ].join(" · ");
}

export const MAX_DELIVERIES_PER_EVENT = 10;
export const MAX_DELIVERIES = 50;
export const DELIVERY_FETCH_LIMIT = 500;

const DELIVERY_STATUSES = new Set(["pending", "delivering", "delivered", "failed"]);

const FAILURE_REASONS = new Set([
  "chat_not_supported",
  "notifier_deleted",
  "notifier_disabled",
  "retries_exhausted",
  "invalid_notifier_properties",
  "environment_not_found",
  "Slack integration not found",
  "Slack invalid blocks",
  "Slack account inactive",
]);

export type DeliveryView = {
  alertEventId: string;
  eventAt: Date;
  notifierId: string;
  status: string;
  failureReason: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
  attempts: number;
};

function deliveryTarget(notifierId: string, labels: Map<string, string>): string {
  const label = labels.get(notifierId);
  if (label !== undefined) {
    return `${fenceCapped(label, "alert-channel-name")} (${plainToken(notifierId, "alert-notifier")})`;
  }
  if (notifierId.startsWith("chat:")) return "a chat notifier";
  return `a channel no longer on this alert${TOKEN.test(notifierId) ? ` (${notifierId})` : ""}`;
}

function deliveryState(delivery: DeliveryView): string {
  const status = DELIVERY_STATUSES.has(delivery.status) ? delivery.status : "unknown";
  const attempts = `attempts ${delivery.attempts}`;
  if (status === "delivered" && delivery.deliveredAt) {
    return `delivered at ${delivery.deliveredAt.toISOString()} · ${attempts}`;
  }
  const reason =
    status !== "failed"
      ? ""
      : delivery.failureReason && FAILURE_REASONS.has(delivery.failureReason)
        ? ` (${delivery.failureReason})`
        : " (other reason)";
  return `${status}${reason} · queued ${delivery.createdAt.toISOString()} · ${attempts}`;
}

export function formatDeliveries(
  events: { id: string; at: Date; type: string }[],
  deliveries: DeliveryView[],
  notifiers: { key: string; label: string }[],
  truncated = false
): string[] {
  const of = (n: number) => (truncated ? `of at least ${n}` : `of ${n}`);
  const labels = new Map(notifiers.map((n) => [n.key, n.label]));
  const lines: string[] = [];
  let shown = 0;
  let total = 0;
  for (const event of events) {
    const own = deliveries.filter(
      (d) => d.alertEventId === event.id && d.eventAt.getTime() === event.at.getTime()
    );
    total += own.length;
    if (own.length === 0 || shown >= MAX_DELIVERIES) continue;
    const take = own.slice(0, Math.min(MAX_DELIVERIES_PER_EVENT, MAX_DELIVERIES - shown));
    shown += take.length;
    lines.push(`- ${event.at.toISOString()} ${plainToken(event.type, "alert-event-type")}:`);
    for (const delivery of take) {
      lines.push(`   - ${deliveryTarget(delivery.notifierId, labels)}: ${deliveryState(delivery)}`);
    }
    if (own.length > take.length) {
      lines.push(`   Showing ${take.length} ${of(own.length)} deliveries for this event.`);
    }
  }
  if (lines.length === 0) return ["Deliveries for recent activity: none"];
  if (truncated || total > shown) lines.push(`Showing ${shown} ${of(total)} deliveries.`);
  return ["Deliveries for recent activity (newest event first):", ...lines];
}
