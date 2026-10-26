import { getCapability } from "@internal/alert-contracts";
import type { Alert, AlertEvent } from "../storage/alertStore.server";
import {
  alertOccurrenceDetail,
  alertQueryDetail,
  CUSTOM_QUERY_CAPABILITY_KEY,
} from "emails/src/alertRaisedContent";

function formatSeconds(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

function formatValue(value: number, unit: unknown): string {
  switch (unit) {
    case "percent":
      return `${value}%`;
    case "duration_ms":
    case "ms":
      return value >= 1000 ? `${Number((value / 1000).toFixed(2))}s` : `${value}ms`;
    case "seconds":
      return `${value}s`;
    case "rate_per_hour":
      return `${value}/h`;
    default:
      return String(value);
  }
}

function readingSentence(facts: Record<string, unknown>, title: string): string {
  const { value, threshold, unit, windowSec } = facts;
  if (typeof value !== "number") return "";
  const window =
    typeof windowSec === "number" && windowSec > 0
      ? ` in the last ${formatSeconds(windowSec)}`
      : "";
  const limit = typeof threshold === "number" ? `, threshold ${formatValue(threshold, unit)}` : "";
  return ` ${title} was ${formatValue(value, unit)}${window}${limit}.`;
}

function occurrenceSentence(facts: unknown, errorTitle?: string | null): string {
  const detail = alertOccurrenceDetail(facts, errorTitle);
  return detail ? ` ${detail}.` : "";
}

function chatPrefix(type: string, name: string): string {
  switch (type) {
    case "raised":
      return `Alert raised: ${name}`;
    case "recovered":
      return `Alert recovered: ${name}`;
    case "resolved":
      return `Alert resolved: ${name}`;
    case "expired":
      return `Alert expired: ${name}`;
    case "stopped":
      return `Alert stopped: ${name}`;
    default:
      return `Alert update: ${name}`;
  }
}

export function alertEventChatText(
  event: Pick<AlertEvent, "type" | "facts">,
  alert: Pick<Alert, "name" | "capabilityKey">,
  errorTitle?: string | null
): string {
  const name = alert.name ?? alert.capabilityKey;
  const title = getCapability(alert.capabilityKey)?.title ?? alert.capabilityKey;
  if (alert.capabilityKey === CUSTOM_QUERY_CAPABILITY_KEY) {
    const detail = alertQueryDetail(event.facts, name);
    const prefix = chatPrefix(event.type, name);
    return detail ? `${prefix}\n${detail}` : `${prefix}.`;
  }
  const reading =
    readingSentence((event.facts ?? {}) as Record<string, unknown>, title) ||
    (event.type === "raised" ? occurrenceSentence(event.facts, errorTitle) : "");

  switch (event.type) {
    case "raised":
      return `Alert raised: ${name}.${reading}`;
    case "recovered":
      return `Alert recovered: ${name}.${reading}`;
    case "resolved":
      return `Alert resolved: ${name}.${reading}`;
    case "expired":
      return `Alert expired: ${name}.`;
    case "stopped":
      return `Alert stopped: ${name}.`;
    default:
      return `Alert update: ${name}.${reading}`;
  }
}
