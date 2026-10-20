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
