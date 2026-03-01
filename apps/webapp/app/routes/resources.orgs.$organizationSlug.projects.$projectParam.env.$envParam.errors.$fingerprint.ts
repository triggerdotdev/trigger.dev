import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/node";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { ErrorGroupPresenter, ErrorGroupOptionsSchema } from "~/presenters/v3/ErrorGroupPresenter.server";
import { $replica } from "~/db.server";
import { logsClickhouseClient } from "~/services/clickhouseInstance.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);
  const fingerprint = params.fingerprint;

  if (!fingerprint) {
    throw new Response("Fingerprint parameter is required", { status: 400 });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  // Get pagination from query params
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const options = ErrorGroupOptionsSchema.parse({
    userId,
    projectId: project.id,
    fingerprint,
    cursor,
  }) as any; // Validated by ErrorGroupOptionsSchema at runtime

  const presenter = new ErrorGroupPresenter($replica, logsClickhouseClient);
  const result = await presenter.call(project.organizationId, environment.id, options);

  return json({
    errorGroup: result.errorGroup,
    instances: result.instances,
    pagination: result.pagination,
  });
};
