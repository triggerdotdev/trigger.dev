import { json } from "@remix-run/server-runtime";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { loadPreviewSeries, QuerySchema } from "~/v3/services/alerts/previewSeries.server";
import { requireAlertsEnabledOrForbid } from "~/v3/canUseAlertsList.server";

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "alerts" } },
  },
  async ({ request, params, user, ability }) => {
    const userId = user.id;
    const { organizationSlug, projectParam, envParam } = params;
    await requireAlertsEnabledOrForbid(userId, organizationSlug);

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
    }
    // eslint-disable-next-line no-control-regex
    if (parsed.data.scopeValue && /[\x00-\x1f]/.test(parsed.data.scopeValue)) {
      return json({ error: "Invalid scope value" }, { status: 400 });
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
      const result = await loadPreviewSeries({
        userId,
        organizationSlug,
        projectParam,
        envParam,
        ...parsed.data,
      });

      return json(result.body, { status: result.status });
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to load alert preview series", {
        userId,
        organizationSlug,
        projectParam,
        error,
      });
      throw error;
    }
  }
);
