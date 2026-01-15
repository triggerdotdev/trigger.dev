import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/node";
import { z } from "zod";
import { MachinePresetName } from "@trigger.dev/core/v3";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { $replica } from "~/db.server";
import type { TaskRunStatus } from "@trigger.dev/database";

// Valid TaskRunStatus values
const VALID_TASK_RUN_STATUSES = [
  "PENDING",
  "QUEUED",
  "EXECUTING",
  "WAITING_FOR_EXECUTION",
  "WAITING",
  "COMPLETED_SUCCESSFULLY",
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "FAILURE",
  "CANCELED",
] as const;

// Schema for validating run context data
export const RunContextSchema = z.object({
  id: z.string(),
  friendlyId: z.string(),
  taskIdentifier: z.string(),
  status: z.enum(VALID_TASK_RUN_STATUSES),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  isTest: z.boolean(),
  tags: z.array(z.string()),
  queue: z.string(),
  concurrencyKey: z.string().nullable(),
  usageDurationMs: z.number(),
  costInCents: z.number(),
  baseCostInCents: z.number(),
  machinePreset: MachinePresetName.nullable(),
  version: z.string().optional(),
  rootRun: z
    .object({
      friendlyId: z.string(),
      taskIdentifier: z.string(),
    })
    .nullable(),
  parentRun: z
    .object({
      friendlyId: z.string(),
      taskIdentifier: z.string(),
    })
    .nullable(),
  batch: z
    .object({
      friendlyId: z.string(),
    })
    .nullable(),
  schedule: z
    .object({
      friendlyId: z.string(),
    })
    .nullable(),
});

export type RunContext = z.infer<typeof RunContextSchema>;

// Fetch run context for a log entry
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, logId } = {
    ...EnvironmentParamSchema.parse(params),
    logId: params.logId,
  };

  if (!logId) {
    throw new Response("Log ID is required", { status: 400 });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  // Parse the logId to extract runId
  // Log ID format: traceId::spanId::runId::startTime (base64 encoded or plain)
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");

  if (!runId) {
    throw new Response("Run ID is required", { status: 400 });
  }

  // Fetch run details from Postgres
  const run = await $replica.taskRun.findFirst({
    select: {
      id: true,
      friendlyId: true,
      taskIdentifier: true,
      status: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
      isTest: true,
      runTags: true,
      queue: true,
      concurrencyKey: true,
      usageDurationMs: true,
      costInCents: true,
      baseCostInCents: true,
      machinePreset: true,
      scheduleId: true,
      lockedToVersion: {
        select: {
          version: true,
        },
      },
      rootTaskRun: {
        select: {
          friendlyId: true,
          taskIdentifier: true,
        },
      },
      parentTaskRun: {
        select: {
          friendlyId: true,
          taskIdentifier: true,
        },
      },
      batch: {
        select: {
          friendlyId: true,
        },
      },
    },
    where: {
      friendlyId: runId,
      runtimeEnvironmentId: environment.id,
    },
  });

  if (!run) {
    return json({ run: null });
  }

  // Fetch schedule if scheduleId exists
  let schedule: { friendlyId: string } | null = null;
  if (run.scheduleId) {
    const scheduleData = await $replica.taskSchedule.findFirst({
      select: { friendlyId: true },
      where: { id: run.scheduleId },
    });
    schedule = scheduleData;
  }

  const runData = {
    id: run.id,
    friendlyId: run.friendlyId,
    taskIdentifier: run.taskIdentifier,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
    isTest: run.isTest,
    tags: run.runTags,
    queue: run.queue,
    concurrencyKey: run.concurrencyKey,
    usageDurationMs: run.usageDurationMs,
    costInCents: run.costInCents,
    baseCostInCents: run.baseCostInCents,
    machinePreset: run.machinePreset,
    version: run.lockedToVersion?.version,
    rootRun: run.rootTaskRun
      ? {
          friendlyId: run.rootTaskRun.friendlyId,
          taskIdentifier: run.rootTaskRun.taskIdentifier,
        }
      : null,
    parentRun: run.parentTaskRun
      ? {
          friendlyId: run.parentTaskRun.friendlyId,
          taskIdentifier: run.parentTaskRun.taskIdentifier,
        }
      : null,
    batch: run.batch ? { friendlyId: run.batch.friendlyId } : null,
    schedule: schedule,
  };

  // Validate the run data
  const validatedRun = RunContextSchema.parse(runData);

  return json({
    run: validatedRun,
  });
};
