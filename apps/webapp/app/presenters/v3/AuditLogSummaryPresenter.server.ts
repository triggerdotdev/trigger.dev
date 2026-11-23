import type { AuditLogEventSummary, AuditLogEventSummaryQuery } from "@trigger.dev/plugins";
import { clampToVisibilityWindow } from "~/services/auditLogs/auditEventsApi.server";
import { logger } from "~/services/logger.server";
import { credentialFilter, parseCredentialReference } from "./auditLogCredentials.server";
import {
  auditLogFilters,
  auditLogQuery,
  type AuditLogSearchParams,
} from "./AuditLogPresenter.server";

type SummarizeEvents = (query: AuditLogEventSummaryQuery) => Promise<AuditLogEventSummary | null>;

/**
 * The summary, or why there is none. `noEvents` only when the plugin answered that nothing matches:
 * a summary that failed or can't be loaded says nothing, so the page never claims there were none.
 */
export type AuditLogCredentialSummaryResult = {
  summary: AuditLogEventSummary | null;
  noEvents: boolean;
};

/**
 * When and from where one credential was used, over the events the page lists: the same time range
 * and filters. No summary unless the page is filtered to one credential (picked, or by its last 4),
 * when there's nothing to sum up, or when the summary can't be loaded: the list shows its own error.
 */
export async function auditLogCredentialSummary(
  organizationId: string,
  searchParams: AuditLogSearchParams,
  summarizeEvents: SummarizeEvents
): Promise<AuditLogCredentialSummaryResult> {
  const none = { summary: null, noEvents: false };
  // Never throws: the loader starts it before awaiting the events.
  try {
    const filters = auditLogFilters(searchParams);
    const reference = parseCredentialReference(filters.credential);
    if (!reference && !filters.keyLast4) return none;

    const {
      cursor: _cursor,
      limit: _limit,
      ...query
    } = auditLogQuery(organizationId, filters, searchParams);
    const { from, to } = await clampToVisibilityWindow(organizationId, query);
    if (from >= to) return none;

    const summary = await summarizeEvents({
      ...query,
      from,
      to,
      credential: reference ? credentialFilter(reference) : undefined,
    });
    if (!summary) return none;
    return summary.eventCount > 0
      ? { summary, noEvents: false }
      : { summary: null, noEvents: true };
  } catch (error) {
    logger.warn("Audit logs: credential summary failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return none;
  }
}
