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
      project: {
        select: {
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

  // Get recent runs for the same task
  const recentRuns = await $replica.taskRun.findMany({
    where: {
      taskIdentifier: run.taskIdentifier,
      runtimeEnvironmentId: run.runtimeEnvironmentId,
    },
    select: {
      id: true,
      createdAt: true,
      number: true,
      status: true,
      payload: true,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 20,
  });

  return typedjson({
    payload: await prettyPrintPacket(run.payload, run.payloadType),
    payloadType: run.payloadType,
    environment: displayableEnvironment(environment, userId),
    environments: sortEnvironments(
      run.project.environments.map((environment) => displayableEnvironment(environment, userId))
    ),
    runs: recentRuns,
  });
}

const FormSchema = z.object({
  environment: z.string().optional(),
  payload: z.string().optional(),
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
      environmentId: submission.value.environment,
      payload: submission.value.payload,
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
