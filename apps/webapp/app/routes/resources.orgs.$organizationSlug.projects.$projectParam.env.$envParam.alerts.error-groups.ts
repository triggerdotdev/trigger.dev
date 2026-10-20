import { json } from "@remix-run/server-runtime";
import { toErrorGroupOptions } from "~/components/alerts/errorGroupOptions";
import { $replica } from "~/db.server";
import { ApiErrorGroupPresenter } from "~/presenters/v3/ApiErrorGroupPresenter.server";
import { ErrorsListPresenter } from "~/presenters/v3/ErrorsListPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { loadProjectEnvironmentFromRequest } from "~/services/loadProjectEnvironmentFromRequest.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { errorFingerprint } from "~/utils/errorGroupScope";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "alerts" } },
  },
  async ({ request, params, ability }) => {
    const { project, environment } = await loadProjectEnvironmentFromRequest(request, params);
    if (!ability.can("read", { type: "alerts", envType: environment.type })) {
      return json({ groups: [] }, { status: 403 });
    }

    const id = new URL(request.url).searchParams.get("id");
    if (id) {
      const fingerprint = errorFingerprint(id);
      if (!fingerprint) return json({ groups: [] });
      try {
        const group = await new ApiErrorGroupPresenter().call(
          project.organizationId,
          project.id,
          environment.id,
          fingerprint
        );
        return json({ groups: group ? toErrorGroupOptions([group]) : [] });
      } catch (error) {
        if (error instanceof Response) throw error;
        logger.error("Failed to load error group option", {
          organizationId: project.organizationId,
          projectId: project.id,
          environmentId: environment.id,
          error,
        });
        return json({ groups: [] });
      }
    }

    try {
      const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
        project.organizationId,
        "logs"
      );
      const presenter = new ErrorsListPresenter($replica, clickhouse);

      const { errorGroups } = await presenter.call(project.organizationId, environment.id, {
        projectId: project.id,
        statuses: ["UNRESOLVED"],
        period: "7d",
        pageSize: 50,
      });
      return json({ groups: toErrorGroupOptions(errorGroups) });
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to load error group options", {
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
        error,
      });
      return json({ groups: [] });
    }
  }
);

export type ErrorGroupsLoader = typeof loader;
