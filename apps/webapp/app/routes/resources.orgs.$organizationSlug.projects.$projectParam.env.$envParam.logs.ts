import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/node";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getRunFiltersFromRequest } from "~/presenters/RunFilters.server";
import { LogsListPresenter } from "~/presenters/v3/LogsListPresenter.server";
import { $replica } from "~/db.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const filters = await getRunFiltersFromRequest(request);

  // Get search term and cursor from query params
  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const presenter = new LogsListPresenter($replica, clickhouseClient);
  const result = await presenter.call(project.organizationId, environment.id, {
    userId,
    projectId: project.id,
    ...filters,
    search,
    cursor,
  });

  return json({
    logs: result.logs,
    pagination: result.pagination,
  });
};
