import { parse } from "@conform-to/zod";
import { type ActionFunction, json } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { jsonWithErrorMessage, jsonWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { ResetIdempotencyKeyService } from "~/v3/services/resetIdempotencyKey.server";
import { v3RunParamsSchema } from "~/utils/pathBuilder";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { environment } from "effect/Differ";

export const resetIdempotencyKeySchema = z.object({
  taskIdentifier: z.string().min(1, "Task identifier is required"),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, runParam } =
    v3RunParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: resetIdempotencyKeySchema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const { taskIdentifier } = submission.value;

    const taskRun = await prisma.taskRun.findFirst({
      where: {
        friendlyId: runParam,
        project: {
          slug: projectParam,
          organization: {
            slug: organizationSlug,
            members: {
              some: {
                userId,
              },
            },
          },
        },
        runtimeEnvironment: {
          slug: envParam,
        },
      },
      select: {
        id: true,
        idempotencyKey: true,
        taskIdentifier: true,
        runtimeEnvironmentId: true,
      },
    });

    if (!taskRun) {
      submission.error = { runParam: ["Run not found"] };
      return json(submission);
    }

    if (!taskRun.idempotencyKey) {
      return jsonWithErrorMessage(
        submission,
        request,
        "This run does not have an idempotency key"
      );
    }

    if (taskRun.taskIdentifier !== taskIdentifier) {
      submission.error = { taskIdentifier: ["Task identifier does not match this run"] };
      return json(submission);
    }

    const environment = await prisma.runtimeEnvironment.findUnique({
      where: {
        id: taskRun.runtimeEnvironmentId,
      },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!environment) {
      return jsonWithErrorMessage(
        submission,
        request,
        "Environment not found"
      );
    }

    const service = new ResetIdempotencyKeyService();

    await service.call(taskRun.idempotencyKey, taskIdentifier, {
      ...environment,
      organizationId: environment.project.organizationId,
      organization: environment.project.organization,
    });

    return jsonWithSuccessMessage(
      { success: true },
      request,
      "Idempotency key reset successfully"
    );
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to reset idempotency key", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return jsonWithErrorMessage(
        submission,
        request,
        `Failed to reset idempotency key: ${error.message}`
      );
    } else {
      logger.error("Failed to reset idempotency key", { error });
      return jsonWithErrorMessage(
        submission,
        request,
        `Failed to reset idempotency key: ${JSON.stringify(error)}`
      );
    }
  }
};
