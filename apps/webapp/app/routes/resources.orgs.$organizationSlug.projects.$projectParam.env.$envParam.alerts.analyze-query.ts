import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { MAX_WATCH_QUERY_LENGTH } from "~/components/alerts/queryAlertLink";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { requireAlertsEnabledOrForbid } from "~/v3/canUseAlertsList.server";
import { analyzeQueryPrefill } from "~/v3/services/alerts/queryAlerts/queryAlertPrefill.server";

const AnalyzeQuerySchema = z.object({ query: z.string().min(1).max(MAX_WATCH_QUERY_LENGTH) });

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "alerts" } },
  },
  async ({ request, params, user, ability }) => {
    const { organizationSlug, projectParam, envParam } = params;
    await requireAlertsEnabledOrForbid(user.id, organizationSlug);

    const body = await request.json().catch(() => undefined);
    const parsed = AnalyzeQuerySchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
    }

    const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, user.id);
    if (!project) {
      return json({ error: "Project not found" }, { status: 404 });
    }
    const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
    if (!environment) {
      return json({ error: "Environment not found" }, { status: 404 });
    }
    if (!ability.can("read", { type: "alerts", envType: environment.type })) {
      throwPermissionDenied();
    }

    return json(analyzeQueryPrefill(parsed.data.query.trim()));
  }
);
