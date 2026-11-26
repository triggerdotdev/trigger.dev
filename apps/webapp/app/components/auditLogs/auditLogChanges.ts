import type { AuditLogChanges } from "@trigger.dev/plugins";

/** A recorded value as the detail panel shows it. */
export type AuditLogChangeValue =
  | { kind: "text"; text: string }
  | { kind: "date"; date: string }
  | { kind: "list"; items: string[] };

/** One row of the detail panel's changes: a field, then its value or how it changed. */
export type AuditLogChangeRow =
  | {
      label: string;
      kind: "value";
      value: AuditLogChangeValue;
      /** An env var created or deleted: the whole value was added or removed. */
      tone?: "added" | "removed";
    }
  | { label: string; kind: "changed"; before: AuditLogChangeValue; after: AuditLogChangeValue }
  /** A list field: only what was added and removed. */
  | { label: string; kind: "listChanged"; added: string[]; removed: string[] };

type Format = "text" | "date" | "list" | "key" | "yesNo" | "preset" | "hidden";

/** The fields events record, with how each is named and shown. Others show as recorded. */
const FIELDS: Record<string, { label: string; format: Format; none?: string }> = {
  role: { label: "Role", format: "text" },
  scopes: { label: "Scopes", format: "list" },
  allowedIpRanges: { label: "IP ranges", format: "list", none: "Any" },
  presetId: { label: "Preset", format: "preset" },
  expiresAt: { label: "Expires", format: "date", none: "Never" },
  graceUntil: { label: "Grace until", format: "date" },
  newKeyLast4: { label: "New key", format: "key" },
  previousKeyLast4: { label: "Previous key", format: "key" },
  isSecret: { label: "Secret", format: "yesNo" },
  imported: { label: "Imported", format: "yesNo" },
  via: { label: "Imported with", format: "text" },
  copiedFromEnvironmentName: { label: "Copied from", format: "text" },
  // The name above says it; the id means nothing to a reader.
  copiedFromEnvironmentId: { label: "", format: "hidden" },
  reason: { label: "Reason", format: "text" },
};

type Recorded = string | number | boolean | null;

/** `allowedIpRanges` → `Allowed ip ranges`: a field the page doesn't know yet, readable enough. */
function fieldLabel(field: string) {
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `ENV_VARS_ONLY` → `Env vars only`. */
function presetLabel(id: string) {
  const words = id.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function listItems(value: Recorded): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function display(value: Recorded, format: Format, none = "None"): AuditLogChangeValue {
  if (value === null || value === "") return { kind: "text", text: none };
  switch (format) {
    case "yesNo":
      return { kind: "text", text: value === true || value === "true" ? "Yes" : "No" };
    case "key":
      return { kind: "text", text: `••••${value}` };
    case "preset":
      return { kind: "text", text: presetLabel(String(value)) };
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? { kind: "date", date: value }
        : { kind: "text", text: String(value) };
    case "list": {
      const items = listItems(value);
      return items.length > 0 ? { kind: "list", items } : { kind: "text", text: none };
    }
    default:
      return {
        kind: "text",
        text: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
      };
  }
}

/**
 * What changed, one row per field: a changed field from before to after, a list field by what was
 * added and removed, and other recorded fields as they are. An env var created or deleted leads
 * with its name, added or removed.
 */
export function auditLogChangeRows(
  event: { action: string; target: { name: string | null } },
  changes: AuditLogChanges | null
): AuditLogChangeRow[] {
  const rows: AuditLogChangeRow[] = [];
  const name = event.target.name;
  if (name && (event.action === "envvar.created" || event.action === "envvar.deleted")) {
    rows.push({
      label: "Variable",
      kind: "value",
      value: { kind: "text", text: name },
      tone: event.action === "envvar.created" ? "added" : "removed",
    });
  }
  for (const [field, change] of Object.entries(changes ?? {})) {
    const spec = FIELDS[field] ?? { label: fieldLabel(field), format: "text" as const };
    if (spec.format === "hidden") continue;
    if (change !== null && typeof change === "object") {
      if (spec.format === "list") {
        const before = listItems(change.before);
        const after = listItems(change.after);
        const added = after.filter((item) => !before.includes(item));
        const removed = before.filter((item) => !after.includes(item));
        if (added.length > 0 || removed.length > 0) {
          rows.push({ label: spec.label, kind: "listChanged", added, removed });
          continue;
        }
      }
      rows.push({
        label: spec.label,
        kind: "changed",
        before: display(change.before, spec.format, spec.none),
        after: display(change.after, spec.format, spec.none),
      });
    } else {
      rows.push({
        label: spec.label,
        kind: "value",
        value: display(change, spec.format, spec.none),
      });
    }
  }
  return rows;
}
