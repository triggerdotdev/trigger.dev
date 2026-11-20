import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  AuditEventsSearchParams,
  auditLogErrorKind,
  toAuditEventsResponse,
  toAuditLogEventQuery,
} from "~/services/auditLogs/auditEventsApi.server";
import { organizationHasAuditLogsAccess } from "~/services/auditLogs/auditLogsAccess.server";
import { auditLogs, getAuditLogController } from "~/services/auditLogs/auditLogs.server";
import { logger } from "~/services/logger.server";
import { resolveOrganizationForApiUser } from "~/services/organizationApiAccess.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  orgParam: z.string(),
});

export const loader = createLoaderPATApiRoute(
  {
    params: ParamsSchema,
    searchParams: AuditEventsSearchParams,
    // Resolve the org (id only, no membership) so the plugin can compute the caller's role floor
    // for the manage:audit-logs gate below.
    context: async ({ orgParam }) => {
      const org = await prisma.organization.findFirst({
        where: { OR: [{ id: orgParam }, { slug: orgParam }], deletedAt: null },
        select: { id: true },
      });
      return org ? { organizationId: org.id } : {};
    },
    authorization: { action: "manage", resource: () => ({ type: "audit-logs" }) },
  },
  async ({ params, searchParams, authentication }) => {
    // Membership floor, whatever the token allows. With the RBAC plugin a non-member is refused
    // earlier with a 403; this 404 covers the fallback.
    const organization = await resolveOrganizationForApiUser({
      orgParam: params.orgParam,
      userId: authentication.userId,
    });
    if (!organization) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    // Until the org has audit log access, answer as if the route didn't exist. The org's own flag,
    // with no admin bypass: this route acts as the org, not as a dashboard user.
    if (!(await organizationHasAuditLogsAccess(organization.id))) {
      return json({ error: "Not found" }, { status: 404 });
    }

    // Without the audit plugin (self-hosted) nothing is ever recorded: say so rather than return
    // an empty history that looks real.
    if (!(await getAuditLogController())) {
      return json(
        {
          error: "Audit logs aren't available on this instance.",
          code: "audit_logs_not_available",
        },
        { status: 501 }
      );
    }

    const query = await toAuditLogEventQuery(organization.id, searchParams);
    if ("error" in query) {
      return json({ error: query.error }, { status: 400 });
    }

    try {
      return json(toAuditEventsResponse(await auditLogs.listEvents(query)));
    } catch (error) {
      const kind = auditLogErrorKind(error);
      if (kind === "invalid_query") {
        return json({ error: (error as Error).message }, { status: 400 });
      }
      if (kind === "unavailable") {
        logger.error("Audit events API: listing failed", {
          organizationId: organization.id,
          error: (error as Error).message,
        });
        return json(
          { error: "Audit events are temporarily unavailable. Please try again." },
          { status: 503 }
        );
      }
      throw error;
    }
  }
);
