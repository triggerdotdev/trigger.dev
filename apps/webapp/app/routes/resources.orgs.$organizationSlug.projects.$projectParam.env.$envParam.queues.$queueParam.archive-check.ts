import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { ArchiveQueueService, archiveQueueErrorMessage } from "~/v3/services/archiveQueue.server";
import { queueArchivingEnabled } from "~/v3/services/queueArchivingEnabled.server";

const ParamsSchema = EnvironmentParamSchema.extend({ queueParam: z.string() });

export type ArchiveCheckResult =
  | { archivable: true }
  | { archivable: false; reason: string; activeRuns?: number };

export const loader = dashboardLoader(
  {
    params: ParamsSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: {
      action: "write",
      resource: { type: "tasks" },
      message: "With your current role, you can't manage queues.",
    },
  },
  async ({ params, user }) => {
    const project = await findProjectBySlug(params.organizationSlug, params.projectParam, user.id);
    if (!project) {
      throw new Response(undefined, { status: 404, statusText: "Project not found" });
    }

    const environment = await findEnvironmentBySlug(project.id, params.envParam, user.id);
    if (!environment) {
      throw new Response(undefined, { status: 404, statusText: "Environment not found" });
    }

    if (!(await queueArchivingEnabled(environment.organizationId))) {
      return json<ArchiveCheckResult>({
        archivable: false,
        reason: "Queue archiving isn't enabled for this organization.",
      });
    }

    const result = await new ArchiveQueueService().check(environment, params.queueParam);

    if (result.isErr()) {
      if (result.error.type === "other") {
        logger.error("Queue archive check failed", {
          friendlyId: params.queueParam,
          environmentId: environment.id,
          error: result.error.cause,
        });
      }
      return json<ArchiveCheckResult>({
        archivable: false,
        reason:
          result.error.type === "other"
            ? "Couldn't check this queue. Please try again."
            : archiveQueueErrorMessage(result.error),
      });
    }

    const block = result.value;
    if (!block) {
      return json<ArchiveCheckResult>({ archivable: true });
    }

    return json<ArchiveCheckResult>({
      archivable: false,
      reason: archiveQueueErrorMessage(block),
      activeRuns: block.type === "queue_has_active_runs" ? block.activeRuns : undefined,
    });
  }
);
