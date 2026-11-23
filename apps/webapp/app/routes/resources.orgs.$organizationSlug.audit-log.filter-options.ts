import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { $replica } from "~/db.server";
import { auditLogMenu, isAuditLogMenu } from "~/presenters/v3/auditLogMenus.server";
import {
  AUDIT_LOG_PAGE_AUTHORIZATION,
  auditLogPageContext,
} from "~/services/auditLogs/auditLogPageAccess.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";

const Params = z.object({ organizationSlug: z.string() });

/**
 * One page of one audit log filter menu: `?menu=actor|place|credential`, with an optional `q` to
 * search and, for the places and keys listed, the picked `project` to put first.
 */
export const loader = dashboardLoader(
  { params: Params, context: auditLogPageContext, authorization: AUDIT_LOG_PAGE_AUTHORIZATION },
  async ({ request, user, context }) => {
    if (!context.organizationId) {
      throw new Response("Not Found", { status: 404 });
    }
    const url = new URL(request.url);
    const menu = url.searchParams.get("menu");
    if (!isAuditLogMenu(menu)) {
      throw new Response("Unknown menu", { status: 400 });
    }

    return typedjson(
      await auditLogMenu($replica, menu, {
        organizationId: context.organizationId,
        viewerId: user.id,
        search: (url.searchParams.get("q") ?? "").trim().slice(0, 100),
        projectId: url.searchParams.get("project")?.slice(0, 128) || undefined,
      })
    );
  }
);
