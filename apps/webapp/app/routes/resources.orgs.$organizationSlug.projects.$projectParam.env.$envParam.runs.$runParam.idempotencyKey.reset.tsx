import { type ActionFunction, json } from "@remix-run/node";
import { prisma } from "~/db.server";
import { jsonWithErrorMessage, jsonWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { ResetIdempotencyKeyService } from "~/v3/services/resetIdempotencyKey.server";
import { v3RunParamsSchema } from "~/utils/pathBuilder";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";

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

    // Resolve run from PG or the mollifier buffer (Q5). For a buffered
    // run the snapshot carries the idempotencyKey + taskIdentifier; we
    // also need the runtimeEnvironmentId to feed ResetIdempotencyKeyService
    // (which clears both PG and the buffer lookup — B6b).
    let resolved:
      | { idempotencyKey: string; taskIdentifier: string; runtimeEnvironmentId: string }
      | null = null;
    if (taskRun) {
      if (!taskRun.idempotencyKey) {
        return jsonWithErrorMessage({}, request, "This run does not have an idempotency key");
      }
      resolved = {
        idempotencyKey: taskRun.idempotencyKey,
        taskIdentifier: taskRun.taskIdentifier,
        runtimeEnvironmentId: taskRun.runtimeEnvironmentId,
      };
    } else {
      const buffer = getMollifierBuffer();
      const entry = buffer ? await buffer.getEntry(runParam) : null;
      if (!entry) {
        return jsonWithErrorMessage({}, request, "Run not found");
      }
      const member = await prisma.orgMember.findFirst({
        where: { userId, organizationId: entry.orgId },
        select: { id: true },
      });
      if (!member) {
        return jsonWithErrorMessage({}, request, "Run not found");
      }
      const synthetic = await findRunByIdWithMollifierFallback({
        runId: runParam,
        environmentId: entry.envId,
        organizationId: entry.orgId,
      });
      if (!synthetic?.idempotencyKey || !synthetic.taskIdentifier) {
        return jsonWithErrorMessage({}, request, "This run does not have an idempotency key");
      }
      resolved = {
        idempotencyKey: synthetic.idempotencyKey,
        taskIdentifier: synthetic.taskIdentifier,
        runtimeEnvironmentId: entry.envId,
      };
    }

    const environment = await prisma.runtimeEnvironment.findUnique({
      where: {
        id: resolved.runtimeEnvironmentId,
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

    await service.call(resolved.idempotencyKey, resolved.taskIdentifier, {
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
