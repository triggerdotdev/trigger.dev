import { json } from "@remix-run/server-runtime";
import { withAdminAudit } from "~/services/adminAudit/adminAudit.server";
import {
  canDisableProjectVault,
  disableProjectVault,
} from "~/services/secretProxy/projectVault.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

/**
 * Platform admins only, usually while impersonating the customer: turns Agent Vault off for a
 * project with no Vault values. Recorded in the admin audit log under the real admin.
 */
export const action = withAdminAudit(
  dashboardAction(
    {
      params: EnvironmentParamSchema,
      context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    },
    async ({ context, user, request }) => {
      if (!context.projectId) {
        throw new Response("Not Found", { status: 404 });
      }
      if (!(await canDisableProjectVault(request, user))) {
        throw new Response("Forbidden", { status: 403 });
      }
      const result = await disableProjectVault(context.projectId);
      return result.success
        ? json({ success: true })
        : json({ error: result.error }, { status: 400 });
    }
  )
);
