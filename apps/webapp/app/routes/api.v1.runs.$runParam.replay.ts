import { EngineServiceValidationError } from "@internal/run-engine";
import { json } from "@remix-run/server-runtime";
import { ReplayRunRequestBody } from "@trigger.dev/core/v3";
import type { TaskRun } from "@trigger.dev/database";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { runStore } from "~/v3/runStore.server";
import { logger } from "~/services/logger.server";
import { anyResource, createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ReplayTaskRunService } from "~/v3/services/replayTaskRun.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { resolveRunForMutation } from "~/v3/mollifier/resolveRunForMutation.server";
import { sanitizeTriggerSource } from "~/utils/triggerSource";
import { clientSafeErrorMessage } from "~/utils/prismaErrors";
import { readBoundedBodyText } from "~/utils/boundedRequestBody.server";
import { safeJsonParse } from "~/utils/json";

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

async function parseReplayOverrides(
  request: Request
): Promise<
  { ok: true; overrides: z.infer<typeof ReplayRunRequestBody> } | { ok: false; response: Response }
> {
  const body = await readBoundedBodyText(request, env.TASK_PAYLOAD_MAXIMUM_SIZE);

  if (!body.ok) {
    return {
      ok: false,
      response: json(
        {
          error: `Request body exceeds the maximum size of ${env.TASK_PAYLOAD_MAXIMUM_SIZE} bytes`,
        },
        { status: 413 }
      ),
    };
  }

  const rawBody = body.text;

  if (rawBody.trim().length === 0) {
    return { ok: true, overrides: {} };
  }

  const parsedJson = safeJsonParse(rawBody);

  if (parsedJson === null || typeof parsedJson !== "object") {
    return { ok: false, response: json({ error: "Invalid JSON" }, { status: 400 }) };
  }

  const parsed = ReplayRunRequestBody.safeParse(parsedJson);

  if (!parsed.success) {
    return {
      ok: false,
      response: json({ error: fromZodError(parsed.error).toString() }, { status: 400 }),
    };
  }

  return { ok: true, overrides: parsed.data };
}

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "POST",
    allowJWT: true,
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
  async ({ request, params, authentication, ability }) => {
    const { runParam } = params;

    const body = await parseReplayOverrides(request);

    if (!body.ok) {
      return body.response;
    }

    const { overrides } = body;

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

      if (!ability.can("trigger", { type: "tasks", id: taskRun.taskIdentifier })) {
        return json(
          {
            error: `Replaying this run needs permission to trigger the ${taskRun.taskIdentifier} task`,
          },
          { status: 403 }
        );
      }

      const triggerSource = sanitizeTriggerSource(request.headers.get("x-trigger-source")) ?? "api";

      const service = new ReplayTaskRunService();
      const newRun = await service.call(taskRun, {
        triggerSource,
        payload:
          overrides.payload === undefined
            ? undefined
            : overrides.payloadType === "application/super+json"
              ? (overrides.payload as string)
              : JSON.stringify(overrides.payload),
        payloadType: overrides.payloadType ?? "application/json",
        metadata: overrides.metadata,
        tags: typeof overrides.tags === "string" ? [overrides.tags] : overrides.tags,
        queue: overrides.queue,
        concurrencyKey: overrides.concurrencyKey,
        machine: overrides.machine,
        version: overrides.version,
        region: overrides.region,
        delay: overrides.delay,
        ttl: overrides.ttl,
        idempotencyKey: overrides.idempotencyKey,
        idempotencyKeyTTL: overrides.idempotencyKeyTTL,
        maxAttempts: overrides.maxAttempts,
        maxDurationSeconds: overrides.maxDuration,
        prioritySeconds: overrides.priority,
      });

      if (!newRun) {
        return json({ error: "Failed to create new run" }, { status: 400 });
      }

      return json({
        id: newRun?.friendlyId,
      });
    } catch (error) {
      if (
        error instanceof ServiceValidationError ||
        error instanceof EngineServiceValidationError
      ) {
        return json({ error: error.message }, { status: error.status ?? 400 });
      }

      if (error instanceof Error) {
        logger.error("Failed to replay run", {
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
          run: runParam,
          environmentId: authentication.environment.id,
        });
        return json({ error: clientSafeErrorMessage(error) }, { status: 400 });
      } else {
        logger.error("Failed to replay run", {
          error: JSON.stringify(error),
          run: runParam,
          environmentId: authentication.environment.id,
        });
        return json({ error: JSON.stringify(error) }, { status: 400 });
      }
    }
  }
);

export { action };
