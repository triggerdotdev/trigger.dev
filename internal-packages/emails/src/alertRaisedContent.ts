export const ALERT_RAISED_LABEL = "Alert raised";
export const ALERT_RAISED_BUTTON_TEXT = "Open the dashboard";

function formatRaisedAt(raisedAt: string) {
  const date = new Date(raisedAt);
  if (Number.isNaN(date.getTime())) return raisedAt;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function alertRaisedSentence(params: {
  alertName: string;
  project: string;
  environment: string;
  raisedAt: string;
}) {
  return `The alert “${params.alertName}” triggered for ${params.project} (${params.environment}) at ${formatRaisedAt(params.raisedAt)}.`;
}

export function occurrenceFingerprint(facts: unknown): string | null {
  const fingerprint = (facts as Record<string, unknown> | null)?.error_fingerprint;
  return typeof fingerprint === "string" && fingerprint ? fingerprint : null;
}

export function linkFingerprint(capabilityKey: string, facts: unknown): string | null {
  return capabilityKey === CUSTOM_QUERY_CAPABILITY_KEY ? null : occurrenceFingerprint(facts);
}

export function alertOccurrenceDetail(facts: unknown, errorTitle?: string | null): string | null {
  const record = (facts ?? {}) as Record<string, unknown>;
  const fingerprint = occurrenceFingerprint(record);
  const task = record.task_identifier;
  if (!fingerprint || typeof task !== "string") return null;

  const base = errorTitle ? `${task}: ${errorTitle}` : `${task} · ${fingerprint.slice(0, 8)}`;

  if (typeof record.occurrences === "number") {
    const count = `${record.occurrences} ${record.occurrences === 1 ? "occurrence" : "occurrences"}`;
    const minute = typeof record.minute === "string" ? ` at ${formatRaisedAt(record.minute)}` : "";
    return `${base} — ${count}${minute}`;
  }
  return `${base} — New error group`;
}

export const CUSTOM_QUERY_CAPABILITY_KEY = "custom.query";
const MAX_LISTED = 10;

function windowLabel(sec: number) {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

const MAX_CELL = 80;

function cell(value: unknown) {
  const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
}

export function boundDetail(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text
    .slice(0, max)
    .replace(/&[a-z#0-9]*$/i, "")
    .replace(/\n[^\n]*$/, "");
  return `${cut}\n…`;
}

export function alertQueryDetail(facts: unknown, alertName: string): string | null {
  const record = (facts ?? {}) as Record<string, unknown>;
  const batch = record.batch as
    | {
        rows?: Array<{ id: string; time: string; columns?: Record<string, unknown> }>;
        total?: number;
        overflow?: number;
      }
    | undefined;

  if (batch && Array.isArray(batch.rows) && batch.rows.length > 0) {
    const lines = batch.rows.slice(0, MAX_LISTED).map((row) => {
      const columns = Object.entries(row.columns ?? {})
        .map(([key, value]) => `${key}=${cell(value)}`)
        .join(", ");
      return [cell(row.id), formatRaisedAt(row.time), columns].filter(Boolean).join(" · ");
    });
    const total = typeof batch.total === "number" ? batch.total : batch.rows.length;
    const more = Math.max(
      typeof batch.overflow === "number" ? batch.overflow : 0,
      total - lines.length
    );
    if (more > 0) lines.push(`and ${more} more`);
    return `${alertName}: ${total} new ${total === 1 ? "row" : "rows"}\n${lines.join("\n")}`;
  }

  const { measure, value, threshold, windowSec } = record;
  if (typeof measure !== "string" || typeof value !== "number") return null;
  const window =
    typeof windowSec === "number" && windowSec > 0 ? ` over ${windowLabel(windowSec)}` : "";
  const relation =
    typeof threshold === "number"
      ? ` ${value > threshold ? "above" : value < threshold ? "below" : "at"} ${threshold}`
      : "";
  const head = `${alertName}: ${measure} ${value}${relation}${window}`;

  const offenders = Array.isArray(record.offenders)
    ? (record.offenders as Array<{ key?: unknown; value?: unknown }>)
    : [];
  if (offenders.length === 0) return head;
  const lines = offenders.slice(0, MAX_LISTED).map((o) => `${cell(o.key)}: ${cell(o.value)}`);
  return `${head}\n${lines.join("\n")}`;
}
