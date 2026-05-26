import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { TaskRun } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ReplayTaskRunService } from "~/v3/services/replayTaskRun.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { sanitizeTriggerSource } from "~/utils/triggerSource";

const ParamsSchema = z.object({
  /* This is the run friendly ID */
  runParam: z.string(),
});

// Subset of TaskRun fields that ReplayTaskRunService.call actually
// reads from `existingTaskRun`. Validate the buffered fallback against
// this before casting to TaskRun so a buffer-format drift surfaces as a
// 404/422 here rather than as a silent NaN/undefined deep inside
// replay. The full TaskRun type has many more fields the service never
// touches; we only assert the ones it reads.
const BufferedReplayInputSchema = z.object({
  id: z.string(),
  friendlyId: z.string(),
  runtimeEnvironmentId: z.string(),
  taskIdentifier: z.string(),
  payload: z.string(),
  payloadType: z.string(),
  queue: z.string(),
  isTest: z.boolean(),
  traceId: z.string(),
  spanId: z.string(),
  engine: z.string(),
  runTags: z.array(z.string()),
  // Nullable / optional fields the service tolerates via `??` fallbacks.
  concurrencyKey: z.string().nullable().optional(),
  workerQueue: z.string().nullable().optional(),
  machinePreset: z.string().nullable().optional(),
  realtimeStreamsVersion: z.string().nullable().optional(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return json({ error: "Invalid or missing run ID" }, { status: 400 });
  }

  const { runParam } = parsed.data;

  try {
    const env = authenticationResult.environment;
    // PG-first. Replay works on any status per audit (Q2 design) — no
    // filter beyond friendlyId is the existing semantic; findFirst with
    // env scoping tightens it minimally without changing behaviour for
    // a correctly-authed caller.
    let taskRun: TaskRun | null = await prisma.taskRun.findFirst({
      where: {
        friendlyId: runParam,
        runtimeEnvironmentId: env.id,
      },
    });

    if (!taskRun) {
      // Buffered fallback (Q2). The SyntheticRun shape was extended in
      // Phase B4 to carry every field ReplayTaskRunService reads from a
      // TaskRun. Validate the subset of fields the service consumes
      // (BufferedReplayInputSchema above) before casting; a schema
      // mismatch surfaces as a 404 here rather than as a silent
      // undefined deep inside the service.
      const buffered = await findRunByIdWithMollifierFallback({
        runId: runParam,
        environmentId: env.id,
        organizationId: env.organizationId,
      });
      if (buffered) {
        const parsed = BufferedReplayInputSchema.safeParse(buffered);
        if (parsed.success) {
          taskRun = parsed.data as unknown as TaskRun;
        } else {
          logger.warn("replay: buffered fallback failed schema validation", {
            runParam,
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
            })),
          });
        }
      }
    }

    if (!taskRun) {
      return json({ error: "Run not found" }, { status: 404 });
    }

    const triggerSource =
      sanitizeTriggerSource(request.headers.get("x-trigger-source")) ?? "api";

    const service = new ReplayTaskRunService();
    const newRun = await service.call(taskRun, { triggerSource });

    if (!newRun) {
      return json({ error: "Failed to create new run" }, { status: 400 });
    }

    return json({
      id: newRun?.friendlyId,
    });
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to replay run", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
        run: runParam,
      });
      return json({ error: error.message }, { status: 400 });
    } else {
      logger.error("Failed to replay run", { error: JSON.stringify(error), run: runParam });
      return json({ error: JSON.stringify(error) }, { status: 400 });
    }
  }
}
