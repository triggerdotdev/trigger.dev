import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { requireUserId } from "~/services/session.server";
import { LogDetailPresenter } from "~/presenters/v3/LogDetailPresenter.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { $replica } from "~/db.server";

const LogIdParamsSchema = z.object({
  organizationSlug: z.string(),
  projectParam: z.string(),
  envParam: z.string(),
  logId: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, logId } = LogIdParamsSchema.parse(params);

  // Validate access to project and environment
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  // Parse logId to extract traceId, spanId, runId, and startTime
  // Format: {traceId}::{spanId}::{runId}::{startTime}
  // All 4 parts are needed to uniquely identify a log entry (multiple events can share the same spanId)
  const decodedLogId = decodeURIComponent(logId);
  const parts = decodedLogId.split("::");
  if (parts.length !== 4) {
    throw new Response("Invalid log ID format", { status: 400 });
  }

  const [traceId, spanId, , startTime] = parts;

  const presenter = new LogDetailPresenter($replica, clickhouseClient);

  const result = await presenter.call({
    environmentId: environment.id,
    organizationId: project.organizationId,
    projectId: project.id,
    spanId,
    traceId,
    startTime,
  });

  if (!result) {
    throw new Response("Log not found", { status: 404 });
  }

  return typedjson(result);
};
