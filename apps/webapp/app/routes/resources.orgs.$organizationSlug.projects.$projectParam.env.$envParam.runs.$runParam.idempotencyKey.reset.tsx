import { prisma } from "~/db.server";
import { jsonWithErrorMessage, jsonWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import {
  dashboardAction,
  type DashboardActionHandlerArgs,
} from "~/services/routeBuilders/dashboardBuilder";
import { v3RunParamsSchema } from "~/utils/pathBuilder";
import { runStore } from "~/v3/runStore.server";
import { ResetIdempotencyKeyService } from "~/v3/services/resetIdempotencyKey.server";

type ProjectAuthScope = Awaited<ReturnType<typeof resolveProjectAuthScope>>;

export const action = dashboardAction(
  {
    params: v3RunParamsSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: {
      action: "write",
      resource: { type: "runs" },
      message: "With your current role, you can't reset idempotency keys.",
    },
  },
  resetIdempotencyKeyAction
);

async function resetIdempotencyKeyAction({
  request,
  params,
  user,
}: DashboardActionHandlerArgs<typeof v3RunParamsSchema, undefined, ProjectAuthScope>) {
  const userId = user.id;
  const { projectParam, organizationSlug, envParam, runParam } = params;

  try {
    const resetSelect = {
      id: true,
      idempotencyKey: true,
      taskIdentifier: true,
      projectId: true,
      runtimeEnvironmentId: true,
    };
    let taskRun = await runStore.findRun({ friendlyId: runParam }, { select: resetSelect });
    if (!taskRun) {
      // Read-your-writes: a just-created run may not have replicated. Re-read the owning primary
      // before 404ing — this null gates the reset mutation below (mirrors cancel/replay).
      taskRun = await runStore.findRunOnPrimary({ friendlyId: runParam }, { select: resetSelect });
    }

    if (!taskRun) {
      return jsonWithErrorMessage({}, request, "Run not found");
    }

    const authorizedProject = await prisma.project.findFirst({
      where: { id: taskRun.projectId, organization: { members: { some: { userId } } } },
      select: { id: true },
    });

    if (!authorizedProject) {
      return jsonWithErrorMessage({}, request, "Run not found");
    }

    if (!taskRun.idempotencyKey) {
      return jsonWithErrorMessage({}, request, "This run does not have an idempotency key");
    }

    const environment = await prisma.runtimeEnvironment.findFirst({
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

    if (
      environment.slug !== envParam ||
      environment.project.slug !== projectParam ||
      environment.project.organization.slug !== organizationSlug
    ) {
      return jsonWithErrorMessage({}, request, "Run not found");
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
}
