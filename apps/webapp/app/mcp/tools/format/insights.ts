import { canonicalJson } from "../../confirm/confirmation.server";
import type { McpToolResult } from "../../gate/withMcpToolAuth.server";
import { untrusted } from "./logFields";

const NAME_CHARS = 256;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const MODEL_NAME = /^[A-Za-z0-9._:/@+-]{1,128}$/;
export const WIDGET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DASHBOARD_ID = /^dashboard_[A-Za-z0-9]{1,64}$/;

/** A tool error as plain text, the same form the confirmation gate uses for a refusal. */
export const plainError = (text: string): McpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** Names the dashboard that was asked for and where to find the right id, without a final period. */
export const dashboardNotFound = (dashboardId: string) =>
  `Dashboard ${plainOr(dashboardId, DASHBOARD_ID, "dashboard-id")} not found; list_dashboards lists the dashboards`;

export function plainOr(value: string, pattern: RegExp, source: string): string {
  return pattern.test(value) ? value : untrusted(value, source, NAME_CHARS);
}

export const fenced = (value: string, source: string, maxChars = NAME_CHARS) =>
  untrusted(value, source, maxChars);

export const fencedJson = (value: unknown, source: string, maxChars: number) =>
  untrusted(canonicalJson(value) ?? "null", source, maxChars);

export const isoTime = (value: Date) => value.toISOString();

export const isoDate = (value: string | null) =>
  value === null ? "unknown" : plainOr(value, ISO_DATE, "date");

export function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
