import { json } from "@remix-run/node";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  LogsListOptionsSchema,
  LogsListPresenter,
  type LogLevel,
} from "~/presenters/v3/LogsListPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { hasLogsPageAccess } from "~/services/logsAccess.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

// Valid log levels for filtering
const validLevels: LogLevel[] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];

function parseLevelsFromUrl(url: URL): LogLevel[] | undefined {
  const levelParams = url.searchParams.getAll("levels").filter((v) => v.length > 0);
  if (levelParams.length === 0) return undefined;
  return levelParams.filter((l): l is LogLevel => validLevels.includes(l as LogLevel));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);
  if (!(await hasLogsPageAccess(user.id, user.admin, user.isImpersonating, organizationSlug))) {
    throw new Response("Logs are not available", { status: 403 });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  // Get the user's plan to determine log retention limit
  const plan = await getCurrentPlan(project.organizationId);
  const retentionLimitDays = plan?.v3Subscription?.plan?.limits.logRetentionDays.number ?? 30;

  // Get filters from query params
  const url = new URL(request.url);
  const tasks = url.searchParams.getAll("tasks").filter((t) => t.length > 0);
  const runId = url.searchParams.get("runId") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const levels = parseLevelsFromUrl(url);
  const period = url.searchParams.get("period") ?? undefined;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  let from = fromStr ? parseInt(fromStr, 10) : undefined;
  let to = toStr ? parseInt(toStr, 10) : undefined;

  if (Number.isNaN(from)) from = undefined;
  if (Number.isNaN(to)) to = undefined;

  const options = LogsListOptionsSchema.parse({
    userId,
    projectId: project.id,
    tasks: tasks.length > 0 ? tasks : undefined,
    runId,
    search,
    cursor,
    period,
    from,
    to,
    levels,
    defaultPeriod: "1d",
    retentionLimitDays,
  }) as any; // Validated by LogsListOptionsSchema at runtime

  const logsClickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "logs"
  );
  const presenter = new LogsListPresenter($replica, logsClickhouse);

  let result;
  try {
    result = await presenter.call(project.organizationId, environment.id, options);
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      throw new Response(error.message, { status: error.status ?? 422 });
    }
    throw error;
  }

  return json({
    logs: result.logs,
    pagination: result.pagination,
  });
};
