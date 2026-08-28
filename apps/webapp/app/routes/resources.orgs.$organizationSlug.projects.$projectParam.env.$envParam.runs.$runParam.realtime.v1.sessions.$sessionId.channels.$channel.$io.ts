import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { SESSION_CHANNEL_NAME_REGEX } from "~/services/realtime/sessionChannels.server";
import {
  canonicalSessionAddressingKey,
  resolveSessionWithWriterFallback,
} from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  runParam: z.string(),
  sessionId: z.string(),
  channel: z.string().regex(SESSION_CHANNEL_NAME_REGEX),
  io: z.enum(["out", "in"]),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const { runParam, sessionId, channel, io } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return new Response("Environment not found", { status: 404 });
  }

  const runWhere = {
    friendlyId: runParam,
    runtimeEnvironmentId: environment.id,
  };
  const runArgs = {
    select: { id: true, friendlyId: true },
  };
  const run =
    (await runStore.findRun(runWhere, runArgs, $replica)) ??
    (await runStore.findRunOnPrimary(runWhere, runArgs));

  if (!run) {
    return new Response("Run not found", { status: 404 });
  }

  const session = await resolveSessionWithWriterFallback(environment.id, sessionId);

  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  const linkWhere = { runId: run.id, sessionId: session.id };
  const linkedSessionRun =
    (await $replica.sessionRun.findFirst({ where: linkWhere, select: { id: true } })) ??
    (await prisma.sessionRun.findFirst({ where: linkWhere, select: { id: true } }));

  if (!linkedSessionRun) {
    return new Response("Session not found for run", { status: 404 });
  }

  const realtimeStream = getRealtimeStreamInstance(environment, "v2", { session });

  if (!(realtimeStream instanceof S2RealtimeStreams)) {
    return new Response("Session channels require the S2 realtime backend", {
      status: 501,
    });
  }

  const lastEventId = request.headers.get("Last-Event-ID") || undefined;
  const timeoutInSecondsRaw = request.headers.get("Timeout-Seconds");
  let timeoutInSeconds: number | undefined;
  if (timeoutInSecondsRaw !== null) {
    timeoutInSeconds = Number(timeoutInSecondsRaw);
    if (!Number.isInteger(timeoutInSeconds) || timeoutInSeconds < 1 || timeoutInSeconds > 600) {
      return new Response("Invalid timeout", { status: 400 });
    }
  }

  const addressingKey = canonicalSessionAddressingKey(session, sessionId);

  return realtimeStream.streamResponseFromSessionStream(
    request,
    addressingKey,
    io,
    getRequestAbortSignal(),
    { lastEventId, timeoutInSeconds },
    channel
  );
}
