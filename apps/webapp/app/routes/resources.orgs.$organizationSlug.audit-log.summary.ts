import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { auditLogSummarySearch } from "~/components/auditLogs/auditLogSummarySearch";
import { $replica } from "~/db.server";
import { AuditLogSearchParams } from "~/presenters/v3/AuditLogPresenter.server";
import { auditLogKeyStatus } from "~/presenters/v3/auditLogKeyStatus.server";
import { parseCredentialReference } from "~/presenters/v3/auditLogCredentials.server";
import { auditLogCredentialSummary } from "~/presenters/v3/AuditLogSummaryPresenter.server";
import {
  AUDIT_LOG_PAGE_AUTHORIZATION,
  auditLogPageContext,
} from "~/services/auditLogs/auditLogPageAccess.server";
import { auditLogs, getAuditLogController } from "~/services/auditLogs/auditLogs.server";
import { logger } from "~/services/logger.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";

const Params = z.object({ organizationSlug: z.string() });

/**
 * When and from where the credential the audit log page is filtered to was used, for the page's
 * filters: the page loads it after it renders, so a slow summary never holds up the list. Takes the
 * page's own URL params, read the same way, so it covers exactly the events the list shows.
 * `search` echoes the filters it answered for, so the page can drop an answer for older filters.
 */
export const loader = dashboardLoader(
  { params: Params, context: auditLogPageContext, authorization: AUDIT_LOG_PAGE_AUTHORIZATION },
  async ({ request, context }) => {
    const organizationId = context.organizationId;
    if (!organizationId) {
      throw new Response("Not Found", { status: 404 });
    }
    const search = auditLogSummarySearch(new URL(request.url).searchParams);
    // Never an error response: the page loads this with a fetcher, and a thrown error would replace
    // the page with its error boundary. A summary that can't be loaded is simply left out.
    try {
      if (!(await getAuditLogController())) {
        return typedjson({ search, summary: null, noEvents: false, keyStatus: null });
      }
      const searchParams = AuditLogSearchParams.parse(
        Object.fromEntries(new URLSearchParams(search))
      );
      const { summary, noEvents } = await auditLogCredentialSummary(
        organizationId,
        searchParams,
        (query) => auditLogs.summarizeEvents(query)
      );
      // The picked key's own last use, which counts unaudited requests too, and how it ended.
      const reference = parseCredentialReference(searchParams.credential);
      // Read even without audited events: a key used only to trigger runs leaves none.
      const keyStatus = reference
        ? await auditLogKeyStatus($replica, organizationId, reference)
        : null;
      return typedjson({ search, summary, noEvents, keyStatus });
    } catch (error) {
      logger.warn("Audit logs: credential summary failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return typedjson({ search, summary: null, noEvents: false, keyStatus: null });
    }
  }
);
