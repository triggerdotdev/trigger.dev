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
  // Note: startTime may be URL-encoded (spaces as %20)
  const decodedLogId = decodeURIComponent(logId);
  const parts = decodedLogId.split("::");
  if (parts.length !== 4) {
    throw new Response("Invalid log ID format", { status: 400 });
  }

  const [traceId, spanId, runId, startTimeStr] = parts;

  const presenter = new LogDetailPresenter($replica, clickhouseClient);

  // Convert startTime string to Date (format: YYYY-MM-DD HH:mm:ss.nanoseconds)
  // JavaScript Date only handles up to milliseconds, so we need to truncate nanoseconds
  let startTimeDate: Date | undefined;
  try {
    // Remove nanoseconds (keep only up to milliseconds) and convert to ISO format
    const dateStr = startTimeStr.split(".")[0].replace(" ", "T") + "Z";
    startTimeDate = new Date(dateStr);
    if (isNaN(startTimeDate.getTime())) {
      startTimeDate = undefined;
    }
  } catch {
    // If parsing fails, continue without time bounds
  }

  const result = await presenter.call({
    environmentId: environment.id,
    organizationId: project.organizationId,
    projectId: project.id,
    spanId,
    traceId,
    startTime: startTimeDate,
  });

  if (!result) {
    throw new Response("Log not found", { status: 404 });
  }

  return typedjson(result);
};
