import type {
  AuditLogListedAction,
  AuditLogListedCategory,
  AuditLogSource,
} from "@trigger.dev/plugins";

/**
 * How a request reached us, as the table's Via column and the Via filter name it. Clients that call
 * the API (the SDK, curl and so on) are all API here; the detail panel names the client.
 */
export const AUDIT_LOG_VIA_LABELS: Record<AuditLogSource, string> = {
  dashboard: "Dashboard",
  api: "API",
  cli: "CLI",
  run: "Task run",
  staff: "Trigger.dev support",
  system: "Trigger.dev",
};

export function isAuditLogVia(value: string | undefined): value is AuditLogSource {
  return value !== undefined && Object.hasOwn(AUDIT_LOG_VIA_LABELS, value);
}

/**
 * The audit log page's category filter: every category, or one. Reads are kept apart from it:
 * they're frequent, so the log leaves them out unless one key or token is filtered, where what it
 * read matters, or a read is picked as the event.
 */
export const AUDIT_LOG_FILTER_CATEGORIES = [
  "all",
  "credentials",
  "envvars",
  "members",
  "support",
] as const;
export type AuditLogFilterCategory = (typeof AUDIT_LOG_FILTER_CATEGORIES)[number];
export const DEFAULT_AUDIT_LOG_FILTER_CATEGORY: AuditLogFilterCategory = "all";

export const AUDIT_LOG_FILTER_CATEGORY_LABELS: Record<AuditLogFilterCategory, string> = {
  all: "All categories",
  credentials: "Credentials",
  envvars: "Environment variables",
  members: "Members",
  support: "Support access",
};

/** A whole key or token pasted into a search, by its prefix. */
const PASTED_KEY = /^(tr|pk)_\S{8,}$/;

/**
 * What a filter menu sends the server for a search. A pasted key, even with spaces or a newline
 * around it, is sent as its last 4, the part events store: the secret stays in the browser.
 */
export function auditLogMenuSearch(search: string): string {
  const trimmed = search.trim();
  return PASTED_KEY.test(trimmed) ? trimmed.slice(-4) : search;
}

/** The time range the page opens on. */
export const AUDIT_LOG_DEFAULT_PERIOD = "7d";

/** Every listed action, in the order the event filter offers them, with its label. */
export const AUDIT_LOG_ACTION_LABELS: Record<AuditLogListedAction, string> = {
  "api_key.created": "API key created",
  "api_key.rotated": "API key rotated",
  "api_key.revoked": "API key revoked",
  "api_key.root_visibility_disabled": "Root key visibility disabled",
  "api_key.ip_ranges_updated": "API key IP ranges updated",
  "api_key.grace_extended": "API key grace period extended",
  "api_key.access_changed": "API key access changed",
  "pat.created": "Personal access token created",
  "pat.revoked": "Personal access token revoked",
  "envvar.created": "Environment variable created",
  "envvar.updated": "Environment variable updated",
  "envvar.value_updated": "Environment variable value updated",
  "envvar.deleted": "Environment variable deleted",
  "envvar.listed": "Environment variables listed",
  "envvar.read": "Environment variable value read",
  "member.added": "Member added",
  "member.invited": "Member invited",
  "invite.revoked": "Invite revoked",
  "invite.accepted": "Invite accepted",
  "member.removed": "Member removed",
  "member.role_changed": "Role changed",
  "support.session_started": "Support session started",
  "support.session_ended": "Support session ended",
};

const LISTED_ACTIONS = Object.keys(AUDIT_LOG_ACTION_LABELS) as AuditLogListedAction[];

/** Each action's category, as the audit log plugin files it. */
const AUDIT_LOG_ACTION_CATEGORIES: Record<AuditLogListedAction, AuditLogListedCategory> = {
  "api_key.created": "credentials",
  "api_key.rotated": "credentials",
  "api_key.revoked": "credentials",
  "api_key.root_visibility_disabled": "credentials",
  "api_key.ip_ranges_updated": "credentials",
  "api_key.grace_extended": "credentials",
  "api_key.access_changed": "credentials",
  "pat.created": "credentials",
  "pat.revoked": "credentials",
  "envvar.created": "envvars",
  "envvar.updated": "envvars",
  "envvar.value_updated": "envvars",
  "envvar.deleted": "envvars",
  "envvar.listed": "envvars",
  "envvar.read": "envvars",
  "member.added": "members",
  "member.invited": "members",
  "invite.revoked": "members",
  "invite.accepted": "members",
  "member.removed": "members",
  "member.role_changed": "members",
  "support.session_started": "support",
  "support.session_ended": "support",
};

/** Reads: who listed env vars or read a value. */
const READ_ACTIONS: AuditLogListedAction[] = ["envvar.listed", "envvar.read"];

/** The actions a category lists, with or without reads. */
export function auditLogActions(
  category: AuditLogFilterCategory,
  includeReads: boolean
): AuditLogListedAction[] {
  return LISTED_ACTIONS.filter(
    (action) =>
      (category === "all" || AUDIT_LOG_ACTION_CATEGORIES[action] === category) &&
      (includeReads || !READ_ACTIONS.includes(action))
  );
}

/** Each category's name in the detail panel. */
export const AUDIT_LOG_CATEGORY_LABELS: Record<AuditLogListedCategory, string> = {
  credentials: "Credentials",
  envvars: "Environment variables",
  members: "Members",
  support: "Support access",
};

/** The dot colour of each category in the table and the detail panel. */
export const AUDIT_LOG_CATEGORY_COLORS: Record<AuditLogListedCategory, string> = {
  credentials: "bg-amber-500",
  envvars: "bg-sky-500",
  members: "bg-emerald-500",
  support: "bg-rose-500",
};

export function isAuditLogFilterCategory(
  value: string | undefined
): value is AuditLogFilterCategory {
  return (AUDIT_LOG_FILTER_CATEGORIES as readonly string[]).includes(value ?? "");
}

export function isListedAuditLogAction(value: string | undefined): value is AuditLogListedAction {
  return value !== undefined && value in AUDIT_LOG_ACTION_LABELS;
}
