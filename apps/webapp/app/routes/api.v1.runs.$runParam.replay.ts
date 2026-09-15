import { json } from "@remix-run/server-runtime";
import type { TaskRun } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import { logger } from "~/services/logger.server";
import { anyResource, createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ReplayTaskRunService } from "~/v3/services/replayTaskRun.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { resolveRunForMutation } from "~/v3/mollifier/resolveRunForMutation.server";
import { sanitizeTriggerSource } from "~/utils/triggerSource";
import { clientSafeErrorMessage } from "~/utils/prismaErrors";

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
  // ReplayTaskRunService.getExistingMetadata reads these to preserve
  // the original run's metadata on replay. Without them in the schema
  // they'd be stripped by Zod's default key-passthrough behaviour, and
  // a buffered-source replay would silently lose metadata that a
  // PG-source replay carries over.
  seedMetadata: z.string().nullable().optional(),
  seedMetadataType: z.string().nullable().optional(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "POST",
    findResource: (params, authentication) =>
      resolveRunForMutation({
        runParam: params.runParam,
        environmentId: authentication.environment.id,
        organizationId: authentication.environment.organizationId,
      }),
    authorization: {
      action: "write",
      resource: (params, _, __, ___, run) =>
        run
          ? anyResource([
              { type: "runs", id: run.friendlyId },
              { type: "tasks", id: run.taskIdentifier },
            ])
          : { type: "runs", id: params.runParam },
    },
  },
  async ({ request, params, authentication }) => {
    const { runParam } = params;

    try {
      const env = authentication.environment;
      // PG-first. Replay works on any status per audit — no
      // filter beyond friendlyId is the existing semantic; findFirst with
      // env scoping tightens it minimally without changing behaviour for
      // a correctly-authed caller.
      let taskRun: TaskRun | null = await runStore.findRun(
        {
          friendlyId: runParam,
          runtimeEnvironmentId: env.id,
        },
        prisma
      );

      if (!taskRun) {
        // Buffered fallback. SyntheticRun carries every field
        // ReplayTaskRunService reads from a TaskRun. Validate the subset of
        // fields the service consumes (BufferedReplayInputSchema above)
        // before casting; a schema mismatch surfaces as a 404 here rather
        // than as a silent undefined deep inside the service.
        const buffered = await findRunByIdWithMollifierFallback({
          runId: runParam,
          environmentId: env.id,
          organizationId: env.organizationId,
        });
        if (buffered) {
          const parsed = BufferedReplayInputSchema.safeParse(buffered);
          if (parsed.success) {
            // Manual sync point: `BufferedReplayInputSchema` covers only
            // the subset of `TaskRun` fields `ReplayTaskRunService.call`
            // currently reads from `existingTaskRun`. The cast is `as
            // unknown as TaskRun` because the full `TaskRun` type carries
            // ~40 fields the service never touches; mirroring all of them
            // on a synthetic snapshot would be misleading. If a future
            // change to `ReplayTaskRunService` reads an additional
            // `existingTaskRun` field, **add it to the schema above** —
            // otherwise the buffered path will silently feed the service
            // `undefined` for that field while the PG-source replay
            // works. The `safeParse` + warn-log + 404 below is the
            // run-time fail-safe; this comment is the design fail-safe.
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

      const triggerSource = sanitizeTriggerSource(request.headers.get("x-trigger-source")) ?? "api";

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
        return json({ error: clientSafeErrorMessage(error) }, { status: 400 });
      } else {
        logger.error("Failed to replay run", { error: JSON.stringify(error), run: runParam });
        return json({ error: JSON.stringify(error) }, { status: 400 });
      }
    }
  }
);

export { action };
