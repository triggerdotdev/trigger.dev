import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  runId: z.string(),
  streamId: z.string(),
});

// GET: SSE stream subscription — authenticated via session cookie
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const { runId, streamId } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return new Response("Environment not found", { status: 404 });
  }

  const run = await $replica.taskRun.findFirst({
    where: {
      friendlyId: runId,
      runtimeEnvironmentId: environment.id,
    },
    select: {
      id: true,
      friendlyId: true,
      realtimeStreamsVersion: true,
    },
  });

  if (!run) {
    return new Response("Run not found", { status: 404 });
  }

  const lastEventId = request.headers.get("Last-Event-ID") || undefined;
  const timeoutInSecondsRaw = request.headers.get("Timeout-Seconds") ?? undefined;
  const timeoutInSeconds = timeoutInSecondsRaw ? parseInt(timeoutInSecondsRaw) : undefined;

  if (timeoutInSeconds && (isNaN(timeoutInSeconds) || timeoutInSeconds < 1 || timeoutInSeconds > 600)) {
    return new Response("Invalid timeout", { status: 400 });
  }

  const realtimeStream = getRealtimeStreamInstance(environment, run.realtimeStreamsVersion);

  return realtimeStream.streamResponse(request, run.friendlyId, streamId, request.signal, {
    lastEventId,
    timeoutInSeconds,
  });
}
