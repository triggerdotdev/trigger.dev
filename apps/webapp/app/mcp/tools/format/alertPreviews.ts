import { createHmac } from "node:crypto";
import { webhookHost } from "./alerts";

const UNSAFE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]|(?! )\p{Zs}/gu;

const escapeCodePoint = (c: string) => {
  const code = c.codePointAt(0)!;
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
};

export const quotedJson = (value: unknown): string =>
  JSON.stringify(value ?? null)
    .replace(/\s{2,}/gu, (run) => [...run].map(escapeCodePoint).join(""))
    .replace(UNSAFE, escapeCodePoint);

export const quoted = (text: string): string => quotedJson(text);

export type PreviewChannel = {
  id: string;
  name: string;
  type: string;
  properties: unknown;
  ref?: string;
};

export function destinationRef(
  channel: {
    type: string;
    properties: unknown;
    enabled: boolean;
    environmentTypes: string[];
    alertTypes: string[];
    integrationId: string | null;
  },
  key: string
): string {
  const p = (channel.properties ?? {}) as {
    url?: unknown;
    email?: unknown;
    channelId?: unknown;
    integrationId?: unknown;
  };
  const destination =
    channel.type === "WEBHOOK"
      ? p.url
      : channel.type === "EMAIL"
        ? p.email
        : [channel.integrationId ?? p.integrationId ?? null, p.channelId ?? null];
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        channel.type,
        destination ?? null,
        channel.enabled,
        [...channel.environmentTypes].sort(),
        [...channel.alertTypes].sort(),
      ])
    )
    .digest("hex")
    .slice(0, 10);
}

export type PreviewNotifier = { type: "channel"; channelId: string } | { type: "chat" };

function notifierLabel(notifier: PreviewNotifier, channels: Map<string, PreviewChannel>): string {
  if (notifier.type === "chat") return "a chat notifier";
  const channel = channels.get(notifier.channelId);
  if (!channel) return `a deleted channel (id ${quoted(notifier.channelId)})`;
  return `${quoted(channel.name)} (channelId ${quoted(channel.id)}, ${channel.type.toLowerCase()}, ${channelTarget(channel)}${channel.ref ? `, destination ref ${channel.ref}` : ""})`;
}

function webhookTarget(url: string): string {
  const host = webhookHost(url);
  try {
    const { port } = new URL(url);
    return host === "unknown host" || !port ? host : `${host}:${port}`;
  } catch {
    return host;
  }
}

function channelTarget(channel: PreviewChannel): string {
  const properties = channel.properties as {
    url?: unknown;
    email?: unknown;
    channelName?: unknown;
  } | null;
  if (channel.type === "WEBHOOK" && typeof properties?.url === "string") {
    return `host ${webhookTarget(properties.url)}`;
  }
  if (channel.type === "EMAIL" && typeof properties?.email === "string") {
    return `email ${quoted(properties.email)}`;
  }
  if (channel.type === "SLACK" && typeof properties?.channelName === "string") {
    return `slack ${quoted(properties.channelName)}`;
  }
  return "no target";
}

export function notifierList(
  notifiers: PreviewNotifier[],
  channels: Map<string, PreviewChannel>
): string {
  return notifiers.length > 0
    ? `[${notifiers.map((n) => notifierLabel(n, channels)).join(", ")}]`
    : "[]";
}

export const expiryText = (date: Date | null | undefined) => (date ? date.toISOString() : "never");

export function alertRef(alert: { id: string; name: string }): string {
  return `${quoted(alert.name)} (id ${quoted(alert.id)})`;
}

export function numbered(title: string, effects: string[]): string {
  return [title, ...effects.map((effect, i) => `${i + 1}. ${effect}`)].join("\n");
}

const NOTHING_CHANGED = "; nothing changed.";

const FIXED_TEXTS = new Set(["Alert not found"]);

export const nothingChanged = (text: string) =>
  FIXED_TEXTS.has(text) || text.endsWith(NOTHING_CHANGED)
    ? text
    : `${text.replace(/[.;]\s*$/, "")}${NOTHING_CHANGED}`;

type ParamsView = {
  environmentId?: string;
  scope?: Record<string, unknown>;
  windowSec?: number;
  querySignal?: {
    mode?: string;
    measure?: string;
    sources?: Array<{ sourceId?: string; windowColumn?: string }>;
    groupColumns?: string[];
    rowId?: { sourceId?: string; column?: string; eventColumn?: string };
  };
};

function scopeText(scope: Record<string, unknown> | undefined): string {
  const text = (key: string) => quoted(String(scope?.[key] ?? ""));
  switch (scope?.type) {
    case "all":
      return "all";
    case "queue":
      return `queue ${text("queue")}`;
    case "queuePattern":
      return `queue pattern ${text("pattern")}`;
    case "task":
      return `task ${text("taskIdentifier")}`;
    case "errorGroup":
      return `error group of task ${text("taskIdentifier")} (fingerprint ${text("fingerprint")})`;
    default:
      return quotedJson(scope);
  }
}

export function paramsText(params: unknown): string {
  const view = (params ?? {}) as ParamsView;
  const parts = [`scope ${scopeText(view.scope)}`];
  if (view.windowSec !== undefined) parts.push(`window ${view.windowSec}s`);
  const signal = view.querySignal;
  if (signal) {
    const sources = (signal.sources ?? [])
      .map((s) => `${quoted(s.sourceId ?? "")} by ${quoted(s.windowColumn ?? "")}`)
      .join(", ");
    const measure = signal.measure === undefined ? "" : ` of ${quoted(signal.measure)}`;
    const grouped = signal.groupColumns?.length
      ? `, grouped by ${quotedJson(signal.groupColumns)}`
      : "";
    const row = signal.rowId
      ? `, row id ${quoted(signal.rowId.column ?? "")} on ${quoted(signal.rowId.sourceId ?? "")} (event ${quoted(signal.rowId.eventColumn ?? "")})`
      : "";
    parts.push(`signal ${signal.mode}${measure} over ${sources}${grouped}${row}`);
  }
  return parts.join(", ");
}
