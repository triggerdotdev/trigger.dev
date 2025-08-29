import { json, TypedResponse } from "@remix-run/server-runtime";
import { WaitForDurationRequestBody, WaitForDurationResponseBody } from "@trigger.dev/core/v3";
import { RunId } from "@trigger.dev/core/v3/isomorphic";

import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { engine } from "~/v3/runEngine.server";

const { action } = createActionApiRoute(
  {
    body: WaitForDurationRequestBody,
    params: z.object({
      runFriendlyId: z.string(),
    }),
    method: "POST",
  },
  async ({ authentication, body, params }): Promise<TypedResponse<WaitForDurationResponseBody>> => {
    const { runFriendlyId } = params;
    const runId = RunId.toId(runFriendlyId);

    try {
      const run = await prisma.taskRun.findFirst({
        where: {
          id: runId,
          runtimeEnvironmentId: authentication.environment.id,
        },
      });

      if (!run) {
        throw new Response("You don't have permissions for this run", { status: 401 });
      }

      const idempotencyKeyExpiresAt = body.idempotencyKeyTTL
        ? resolveIdempotencyKeyTTL(body.idempotencyKeyTTL)
        : undefined;

      const { waitpoint } = await engine.createDateTimeWaitpoint({
        projectId: authentication.environment.project.id,
        environmentId: authentication.environment.id,
        completedAfter: body.date,
        idempotencyKey: body.idempotencyKey,
        idempotencyKeyExpiresAt: idempotencyKeyExpiresAt,
      });

      const waitResult = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: waitpoint.id,
        projectId: authentication.environment.project.id,
        organizationId: authentication.environment.organization.id,
      });

      return json({
        waitUntil: body.date,
        waitpoint: {
          id: waitpoint.friendlyId,
        },
      });
    } catch (error) {
      logger.error("Failed to wait for duration dev", {
        environmentId: authentication.environment.id,
        error,
      });
      throw error;
    }
  }
);

export { action };
