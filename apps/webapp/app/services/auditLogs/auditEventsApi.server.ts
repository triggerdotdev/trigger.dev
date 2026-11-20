import type {
  AuditLogEventPage,
  AuditLogEventQuery,
  AuditLogListedAction,
  AuditLogListedCategory,
} from "@trigger.dev/plugins";
import { z } from "zod";

/** Every category the public API can filter by: all but `auth`, which is never listed. */
const LISTED_CATEGORIES = [
  "credentials",
  "envvars",
  "members",
  "support",
] as const satisfies readonly AuditLogListedCategory[];

/** Every action the public API can filter by. */
const LISTED_ACTIONS = [
  "api_key.created",
  "api_key.rotated",
  "api_key.revoked",
  "api_key.root_visibility_disabled",
  "api_key.ip_ranges_updated",
  "api_key.grace_extended",
  "api_key.access_changed",
  "pat.created",
  "pat.revoked",
  "envvar.created",
  "envvar.updated",
  "envvar.value_updated",
  "envvar.deleted",
  "envvar.listed",
  "envvar.read",
  "member.added",
  "member.invited",
  "invite.revoked",
  "invite.accepted",
  "member.removed",
  "member.role_changed",
  "support.session_started",
  "support.session_ended",
] as const satisfies readonly AuditLogListedAction[];

// Fails to compile when the plugin contract gains a category or action these lists lack.
type MissingCategory = Exclude<AuditLogListedCategory, (typeof LISTED_CATEGORIES)[number]>;
type MissingAction = Exclude<AuditLogListedAction, (typeof LISTED_ACTIONS)[number]>;
const _everyCategoryListed: [MissingCategory] extends [never] ? true : never = true;
const _everyActionListed: [MissingAction] extends [never] ? true : never = true;

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

/** `a,b,c` into a list of values from `allowed`. */
function commaSeparated<T extends string>(allowed: readonly [T, ...T[]]) {
  return z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.enum(allowed)).min(1));
}

/** The start of an ISO 8601 value: its date, and its hour when it has a time. */
const ISO_DATE_AND_HOUR = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?/;

/**
 * Whether an ISO 8601 value names a day that exists and an hour below 24. `Date` rolls both over
 * instead of rejecting them: 30 February becomes 2 March, hour 24 the next day.
 */
function isRealIsoDate(value: string): boolean {
  const match = ISO_DATE_AND_HOUR.exec(value);
  if (!match) return true;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const hourInRange = match[4] === undefined || Number(match[4]) < 24;
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hourInRange;
}

/** An ISO 8601 date, or milliseconds since the epoch. */
const timestamp = z
  .string()
  .refine(isRealIsoDate, { message: "Invalid date" })
  .transform((value) => new Date(/^\d+$/.test(value) ? Number(value) : value))
  .refine((date) => !Number.isNaN(date.getTime()), { message: "Invalid date" });

const id = z.string().min(1).max(128);

/**
 * Query string of `GET /api/v1/orgs/:orgParam/audit-events`. The organization comes from the path
 * and the caller's membership, never from here.
 */
export const AuditEventsSearchParams = z
  .object({
    "page[size]": z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    "page[after]": z.string().min(1).max(1024).optional(),
    "filter[occurredAt][from]": timestamp.optional(),
    "filter[occurredAt][to]": timestamp.optional(),
    "filter[category]": commaSeparated(LISTED_CATEGORIES).optional(),
    "filter[action]": commaSeparated(LISTED_ACTIONS).optional(),
    "filter[actorId]": id.optional(),
    "filter[projectId]": id.optional(),
    "filter[environmentId]": id.optional(),
    "filter[keyLast4]": z.string().length(4).optional(),
  })
  .strict();

export type AuditEventsSearchParams = z.infer<typeof AuditEventsSearchParams>;

type TimeRange = { from: Date; to: Date };

/** Before any audit event: an unbounded start until a visibility window applies. */
const EARLIEST_EVENT = new Date("2000-01-01T00:00:00.000Z");

/**
 * The single place the plan's visibility window is enforced on the public API. Returns the part of
 * the requested range the organization may see.
 *
 * TODO(TRI-15844): no window is decided yet, so this passes the range through unchanged. When one
 * is, move `from` forward to the start of the organization's window here.
 */
async function clampToVisibilityWindow(
  _organizationId: string,
  requested: TimeRange
): Promise<TimeRange> {
  return requested;
}

/** The plugin query for one organization. `organizationId` is the caller's, from the path. */
export async function toAuditLogEventQuery(
  organizationId: string,
  searchParams: AuditEventsSearchParams,
  now: Date = new Date()
): Promise<AuditLogEventQuery | { error: string }> {
  const requested: TimeRange = {
    from: searchParams["filter[occurredAt][from]"] ?? EARLIEST_EVENT,
    to: searchParams["filter[occurredAt][to]"] ?? now,
  };
  if (requested.from >= requested.to) {
    return { error: "filter[occurredAt][from] must be before filter[occurredAt][to]" };
  }

  const { from, to } = await clampToVisibilityWindow(organizationId, requested);

  return {
    organizationId,
    from,
    to,
    categories: searchParams["filter[category]"],
    actions: searchParams["filter[action]"],
    actorId: searchParams["filter[actorId]"],
    projectId: searchParams["filter[projectId]"],
    environmentId: searchParams["filter[environmentId]"],
    keyLast4: searchParams["filter[keyLast4]"],
    cursor: searchParams["page[after]"],
    limit: searchParams["page[size]"],
  };
}

/** The response body. Events are the host's listed events as they are, dates as ISO strings. */
export function toAuditEventsResponse(page: AuditLogEventPage) {
  return {
    data: page.events,
    pagination: page.nextCursor ? { next: page.nextCursor } : {},
  };
}

/**
 * The plugin's errors, matched by name since it is bundled apart from the host. A bad cursor or
 * date is the caller's input; a read failure is the store's.
 */
export function auditLogErrorKind(error: unknown): "invalid_query" | "unavailable" | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === "AuditLogQueryError") return "invalid_query";
  if (error.name === "AuditLogReadError") return "unavailable";
  return undefined;
}
