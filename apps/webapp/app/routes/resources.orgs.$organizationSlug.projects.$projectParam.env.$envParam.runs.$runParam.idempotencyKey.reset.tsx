import { type ActionFunction, json } from "@remix-run/node";
import { prisma } from "~/db.server";
import { jsonWithErrorMessage, jsonWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { ResetIdempotencyKeyService } from "~/v3/services/resetIdempotencyKey.server";
import { v3RunParamsSchema } from "~/utils/pathBuilder";

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, runParam } = v3RunParamsSchema.parse(params);

  try {
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
      return jsonWithErrorMessage({}, request, "Run not found");
    }

    if (!taskRun.idempotencyKey) {
      return jsonWithErrorMessage({}, request, "This run does not have an idempotency key");
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
      return jsonWithErrorMessage({}, request, "Environment not found");
    }

    const service = new ResetIdempotencyKeyService();

    await service.call(taskRun.idempotencyKey, taskRun.taskIdentifier, {
      ...environment,
      organizationId: environment.project.organizationId,
      organization: environment.project.organization,
    });

    return jsonWithSuccessMessage({}, request, "Idempotency key reset successfully");
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to reset idempotency key", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return jsonWithErrorMessage({}, request, `Failed to reset idempotency key: ${error.message}`);
    } else {
      logger.error("Failed to reset idempotency key", { error });
      return jsonWithErrorMessage(
        {},
        request,
        `Failed to reset idempotency key: ${JSON.stringify(error)}`
      );
    }
  }
};
