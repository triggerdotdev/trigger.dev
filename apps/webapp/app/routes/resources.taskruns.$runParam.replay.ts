import { parse } from "@conform-to/zod";
import { type ActionFunction, json, type LoaderFunctionArgs } from "@remix-run/node";
import { prettyPrintPacket } from "@trigger.dev/core/v3";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import {
  getScheduleTaskRunPayload,
  type ScheduledRun,
  type StandardRun,
} from "~/presenters/v3/TestTaskPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { sortEnvironments } from "~/utils/environmentSort";
import { v3RunSpanPath } from "~/utils/pathBuilder";
import { getTimezones } from "~/utils/timezones.server";
import { ReplayTaskRunService } from "~/v3/services/replayTaskRun.server";

const ParamSchema = z.object({
  runParam: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { runParam } = ParamSchema.parse(params);

  const run = await $replica.taskRun.findFirst({
    select: {
      id: true,
      taskIdentifier: true,
      payload: true,
      payloadType: true,
      runtimeEnvironmentId: true,
      seedMetadata: true,
      seedMetadataType: true,
      friendlyId: true,
      status: true,
      number: true,
      createdAt: true,
      project: {
        select: {
          id: true,
          environments: {
            select: {
              id: true,
              type: true,
              slug: true,
              orgMember: {
                select: {
                  user: true,
                },
              },
            },
            where: {
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

  const task = await prisma.backgroundWorkerTask.findFirst({
    where: {
      slug: run.taskIdentifier,
      runtimeEnvironmentId: run.runtimeEnvironmentId,
    },
    select: {
      id: true,
      slug: true,
      filePath: true,
      friendlyId: true,
      triggerSource: true,
    },
  });

  if (!task) throw new Response("Task not found", { status: 404 });

  const shapedTask = {
    ...task,
    taskIdentifier: task.slug,
  };

  const { project, ...runFields } = run;

  if (task.triggerSource === "SCHEDULED") {
    const payload = await getScheduleTaskRunPayload(run);
    if (!payload.success) {
      throw new Error("Invalid payload");
    }

    const shapedRun: ScheduledRun = {
      ...runFields,
      payload: payload.data,
      seedMetadata: run.seedMetadata
        ? await prettyPrintPacket(run.seedMetadata, run.seedMetadataType)
        : undefined,
    };
    return typedjson({
      environment: displayableEnvironment(environment, userId),
      environments: sortEnvironments(
        run.project.environments.map((environment) => displayableEnvironment(environment, userId))
      ),
      taskType: "SCHEDULED",
      task: shapedTask,
      runs: [shapedRun],
      possibleTimezones: getTimezones(),
    });
  } else {
    const shapedRun: StandardRun = {
      ...runFields,
      payload: await prettyPrintPacket(run.payload, run.payloadType),
      seedMetadata: run.seedMetadata
        ? await prettyPrintPacket(run.seedMetadata, run.seedMetadataType)
        : undefined,
    };
    return typedjson({
      environment: displayableEnvironment(environment, userId),
      environments: sortEnvironments(
        run.project.environments.map((environment) => displayableEnvironment(environment, userId))
      ),
      taskType: "STANDARD",
      task: shapedTask,
      runs: [shapedRun],
    });
  }
}

const FormSchema = z.object({
  environmentId: z.string().optional(),
  payload: z.string().optional(),
  metadata: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val) {
        return {};
      }

      try {
        return JSON.parse(val);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Metadata must be a valid JSON string",
        });
        return z.NEVER;
      }
    }),
  failedRedirect: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);

  const { runParam } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: FormSchema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const taskRun = await prisma.taskRun.findUnique({
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
      environmentId: submission.value.environmentId,
      payload: submission.value.payload,
      metadata: submission.value.metadata,
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
    } else {
      logger.error("Failed to replay run", { error });
      return redirectWithErrorMessage(
        submission.value.failedRedirect,
        request,
        JSON.stringify(error)
      );
    }
  }
};
