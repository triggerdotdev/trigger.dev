import { QueryError } from "@internal/clickhouse";
import { json } from "@remix-run/server-runtime";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { isQueryConcurrencyRejection } from "~/services/queryService.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { requireAlertsEnabledOrForbid } from "~/v3/canUseAlertsList.server";
import { previewQueryAlert, PreviewQuerySchema } from "~/v3/services/alerts/previewQuery.server";

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "alerts" } },
  },
  async ({ request, params, user, ability }) => {
    const userId = user.id;
    const { organizationSlug, projectParam, envParam } = params;
    await requireAlertsEnabledOrForbid(userId, organizationSlug);

    const body = await request.json().catch(() => undefined);
    const parsed = PreviewQuerySchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
    }

    const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, userId);
    if (!project) {
      return json({ error: "Project not found" }, { status: 404 });
    }
    const environment = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!environment) {
      return json({ error: "Environment not found" }, { status: 404 });
    }
    if (!ability.can("read", { type: "alerts", envType: environment.type })) {
      throwPermissionDenied();
    }

    try {
      const result = await previewQueryAlert(parsed.data, {
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
      });
      return json(result);
    } catch (error) {
      if (error instanceof Response) throw error;
      if (isQueryConcurrencyRejection(error)) {
        return json({ error: (error as Error).message }, { status: 429 });
      }
      if (error instanceof QueryError) {
        return json({ ok: false, reason: error.message });
      }
      logger.error("Failed to preview query alert", {
        userId,
        organizationSlug,
        projectParam,
        error,
      });
      throw error;
    }
  }
);
