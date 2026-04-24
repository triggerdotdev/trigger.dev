import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  runParam: z.string(),
  runId: z.string(),
  streamId: z.string(),
});

// GET: SSE stream subscription for a run's realtime INPUT stream.
//
// Dashboard-auth counterpart to the public API's
// `/realtime/v1/streams/:runId/input/:streamId` endpoint. Used by the Agent
// tab in the span inspector to observe user messages sent to an agent run
// over the `chat-messages` input stream.
//
// The underlying S2 stream name is `$trigger.input:${streamId}` (mirrors the
// naming used on the write side in `sendInputStream`). The realtime stream
// instance handles the actual SSE proxy; this route just enforces session
// auth and resolves the run.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const { runParam, runId, streamId } = ParamsSchema.parse(params);

  // Defensive: callers should pass the same friendly ID for both the route
  // `:runParam` segment and the stream `:runId` segment.
  if (runParam !== runId) {
    return new Response("Run ID mismatch", { status: 400 });
  }

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

  if (
    timeoutInSeconds &&
    (isNaN(timeoutInSeconds) || timeoutInSeconds < 1 || timeoutInSeconds > 600)
  ) {
    return new Response("Invalid timeout", { status: 400 });
  }

  const realtimeStream = getRealtimeStreamInstance(environment, run.realtimeStreamsVersion);

  // `request.signal` is severed by Remix's Request.clone() + Node undici GC bug
  // (see apps/webapp/CLAUDE.md). Use the Express res.on('close')-backed signal.
  return realtimeStream.streamResponse(
    request,
    run.friendlyId,
    `$trigger.input:${streamId}`,
    getRequestAbortSignal(),
    {
      lastEventId,
      timeoutInSeconds,
    }
  );
}
