import { parse } from "@conform-to/zod";
import { type ActionFunction, json, type LoaderFunctionArgs } from "@remix-run/node";
import { prettyPrintPacket } from "@trigger.dev/core/v3";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { sortEnvironments } from "~/utils/environmentSort";
import { v3RunSpanPath } from "~/utils/pathBuilder";
import { ReplayTaskRunService } from "~/v3/services/replayTaskRun.server";
import parseDuration from "parse-duration";
import { findCurrentWorkerDeployment } from "~/v3/models/workerDeployment.server";
import { queueTypeFromType } from "~/presenters/v3/QueueRetrievePresenter.server";
import { ReplayRunData } from "~/v3/replayTask";

const ParamSchema = z.object({
  runParam: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { runParam } = ParamSchema.parse(params);

  const run = await $replica.taskRun.findFirst({
    select: {
      payload: true,
      payloadType: true,
      seedMetadata: true,
      seedMetadataType: true,
      runtimeEnvironmentId: true,
      concurrencyKey: true,
      maxAttempts: true,
      maxDurationInSeconds: true,
      machinePreset: true,
      ttl: true,
      idempotencyKey: true,
      runTags: true,
      queue: true,
      taskIdentifier: true,
      project: {
        select: {
          environments: {
            select: {
              id: true,
              type: true,
              slug: true,
              branchName: true,
              orgMember: {
                select: {
                  user: true,
                },
              },
            },
            where: {
              archivedAt: null,
              OR: [
                {
                  type: {
                    in: ["PREVIEW", "STAGING", "PRODUCTION"],
                  },
                },
                {
                  type: "DEVELOPMENT",
                  orgMember: {
                    userId,
                  },
                },
              ],
            },
          },
        },
      },
    },
    where: { friendlyId: runParam, project: { organization: { members: { some: { userId } } } } },
  });

  if (!run) {
    throw new Response("Not Found", { status: 404 });
  }

  const environment = run.project.environments.find((env) => env.id === run.runtimeEnvironmentId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const task =
    environment.type !== "DEVELOPMENT"
      ? (await findCurrentWorkerDeployment({ environmentId: environment.id }))?.worker?.tasks.find(
          (t) => t.slug === run.taskIdentifier
        )
      : await $replica.backgroundWorkerTask.findFirst({
          select: {
            queueId: true,
          },
          where: {
            slug: run.taskIdentifier,
            runtimeEnvironmentId: environment.id,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

  const taskQueue = task?.queueId
    ? await $replica.taskQueue.findFirst({
        where: {
          runtimeEnvironmentId: environment.id,
          id: task.queueId,
        },
        select: {
          friendlyId: true,
          name: true,
          type: true,
          paused: true,
        },
      })
    : undefined;

  const backgroundWorkers = await $replica.backgroundWorker.findMany({
    where: {
      runtimeEnvironmentId: environment.id,
    },
    select: {
      version: true,
      engine: true,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 20, // last 20 versions should suffice
  });

  const latestVersions = backgroundWorkers.map((v) => v.version);
  const disableVersionSelection = environment.type === "DEVELOPMENT";
  const allowArbitraryQueues = backgroundWorkers[0]?.engine === "V1";

  return typedjson({
    concurrencyKey: run.concurrencyKey,
    maxAttempts: run.maxAttempts,
    maxDurationSeconds: run.maxDurationInSeconds,
    machinePreset: run.machinePreset,
    ttlSeconds: run.ttl ? parseDuration(run.ttl, "s") ?? undefined : undefined,
    idempotencyKey: run.idempotencyKey,
    runTags: run.runTags,
    payload: await prettyPrintPacket(run.payload, run.payloadType),
    payloadType: run.payloadType,
    queue: run.queue,
    metadata: run.seedMetadata
      ? await prettyPrintPacket(run.seedMetadata, run.seedMetadataType)
      : undefined,
    defaultTaskQueue: taskQueue
      ? {
          id: taskQueue.friendlyId,
          name: taskQueue.name.replace(/^task\//, ""),
          type: queueTypeFromType(taskQueue.type),
          paused: taskQueue.paused,
        }
      : undefined,
    latestVersions,
    disableVersionSelection,
    allowArbitraryQueues,
    environment: {
      ...displayableEnvironment(environment, userId),
      branchName: environment.branchName ?? undefined,
    },
    environments: sortEnvironments(
      run.project.environments.map((environment) => {
        return {
          ...displayableEnvironment(environment, userId),
          branchName: environment.branchName ?? undefined,
        };
      })
    ).filter((env) => {
      if (env.type === "PREVIEW" && !env.branchName) return false;
      return true;
    }),
  });
}

export const action: ActionFunction = async ({ request, params }) => {
  const { runParam } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: ReplayRunData });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const taskRun = await prisma.taskRun.findFirst({
      where: {
        friendlyId: runParam,
      },
      include: {
        runtimeEnvironment: {
          select: {
            slug: true,
          },
        },
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!taskRun) {
      return redirectWithErrorMessage(submission.value.failedRedirect, request, "Run not found");
    }

    const replayRunService = new ReplayTaskRunService();
    const newRun = await replayRunService.call(taskRun, {
      environmentId: submission.value.environment,
      payload: submission.value.payload,
      metadata: submission.value.metadata,
      tags: submission.value.tags,
      queue: submission.value.queue,
      concurrencyKey: submission.value.concurrencyKey,
      maxAttempts: submission.value.maxAttempts,
      maxDurationSeconds: submission.value.maxDurationSeconds,
      machine: submission.value.machine,
      delaySeconds: submission.value.delaySeconds,
      idempotencyKey: submission.value.idempotencyKey,
      idempotencyKeyTTLSeconds: submission.value.idempotencyKeyTTLSeconds,
      ttlSeconds: submission.value.ttlSeconds,
      version: submission.value.version,
    });

    if (!newRun) {
      return redirectWithErrorMessage(
        submission.value.failedRedirect,
        request,
        "Failed to replay run"
      );
    }

    const runPath = v3RunSpanPath(
      {
        slug: taskRun.project.organization.slug,
      },
      { slug: taskRun.project.slug },
      { slug: taskRun.runtimeEnvironment.slug },
      { friendlyId: newRun.friendlyId },
      { spanId: newRun.spanId }
    );

    logger.debug("Replayed run", {
      taskRunId: taskRun.id,
      taskRunFriendlyId: taskRun.friendlyId,
      newRunId: newRun.id,
      newRunFriendlyId: newRun.friendlyId,
      runPath,
    });

    return redirectWithSuccessMessage(runPath, request, `Replaying run`);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to replay run", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return redirectWithErrorMessage(submission.value.failedRedirect, request, error.message);
    }

    logger.error("Failed to replay run", { error });
    return redirectWithErrorMessage(
      submission.value.failedRedirect,
      request,
      JSON.stringify(error)
    );
  }
};
