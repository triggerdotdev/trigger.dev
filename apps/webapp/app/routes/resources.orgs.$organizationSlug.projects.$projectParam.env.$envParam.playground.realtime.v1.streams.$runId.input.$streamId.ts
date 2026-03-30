import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import {
  getInputStreamWaitpoint,
  deleteInputStreamWaitpoint,
} from "~/services/inputStreamWaitpointCache.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { engine } from "~/v3/runEngine.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  runId: z.string(),
  streamId: z.string(),
});

const BodySchema = z.object({
  data: z.unknown(),
});

// POST: Send data to an input stream — authenticated via session cookie
export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const { runId, streamId } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return json({ ok: false, error: "Environment not found" }, { status: 404 });
  }

  const run = await $replica.taskRun.findFirst({
    where: {
      friendlyId: runId,
      runtimeEnvironmentId: environment.id,
    },
    select: {
      id: true,
      friendlyId: true,
      completedAt: true,
      realtimeStreamsVersion: true,
    },
  });

  if (!run) {
    return json({ ok: false, error: "Run not found" }, { status: 404 });
  }

  if (run.completedAt) {
    return json(
      { ok: false, error: "Cannot send to input stream on a completed run" },
      { status: 400 }
    );
  }

  const body = BodySchema.safeParse(await request.json());
  if (!body.success) {
    return json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const realtimeStream = getRealtimeStreamInstance(environment, run.realtimeStreamsVersion);

  const recordId = `inp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const record = JSON.stringify(body.data.data);

  await realtimeStream.appendPart(
    record,
    recordId,
    run.friendlyId,
    `$trigger.input:${streamId}`
  );

  // Complete any linked waitpoint
  const waitpointId = await getInputStreamWaitpoint(runId, streamId);
  if (waitpointId) {
    await engine.completeWaitpoint({
      id: waitpointId,
      output: {
        value: JSON.stringify(body.data.data),
        type: "application/json",
        isError: false,
      },
    });
    await deleteInputStreamWaitpoint(runId, streamId);
  }

  return json({ ok: true });
}
