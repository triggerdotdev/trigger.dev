import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/node";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { ErrorsListPresenter, ErrorsListOptionsSchema } from "~/presenters/v3/ErrorsListPresenter.server";
import { $replica } from "~/db.server";
import { logsClickhouseClient } from "~/services/clickhouseInstance.server";
import { getCurrentPlan } from "~/services/platform.v3.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  // Get the user's plan to determine retention limit
  const plan = await getCurrentPlan(project.organizationId);
  const retentionLimitDays = plan?.v3Subscription?.plan?.limits.logRetentionDays.number ?? 30;

  // Get filters from query params
  const url = new URL(request.url);
  const tasks = url.searchParams.getAll("tasks").filter((t) => t.length > 0);
  const search = url.searchParams.get("search") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const period = url.searchParams.get("period") ?? undefined;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  let from = fromStr ? parseInt(fromStr, 10) : undefined;
  let to = toStr ? parseInt(toStr, 10) : undefined;

  if (Number.isNaN(from)) from = undefined;
  if (Number.isNaN(to)) to = undefined;

  const options = ErrorsListOptionsSchema.parse({
    userId,
    projectId: project.id,
    tasks: tasks.length > 0 ? tasks : undefined,
    search,
    cursor,
    period,
    from,
    to,
    defaultPeriod: "7d",
    retentionLimitDays,
  }) as any; // Validated by ErrorsListOptionsSchema at runtime

  const presenter = new ErrorsListPresenter($replica, logsClickhouseClient);
  const result = await presenter.call(project.organizationId, environment.id, options);

  return json({
    errorGroups: result.errorGroups,
    pagination: result.pagination,
    filters: result.filters,
  });
};
