import { json } from "@remix-run/server-runtime";
import { type WaitForWaitpointTokenResponseBody } from "@trigger.dev/core/v3";
import { RunId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import type { PrismaReplicaClient } from "~/db.server";
import { resolveWaitpointThroughReadThrough } from "~/runEngine/concerns/resolveWaitpointThroughReadThrough.server";
import { logger } from "~/services/logger.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { engine } from "~/v3/runEngine.server";

const { action } = createActionApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
      waitpointFriendlyId: z.string(),
    }),
    maxContentLength: 1024 * 10, // 10KB
    method: "POST",
  },
  async ({ authentication, params }) => {
    // Resume tokens are actually just waitpoints
    const waitpointId = WaitpointId.toId(params.waitpointFriendlyId);
    const runId = RunId.toId(params.runFriendlyId);

    try {
      //check permissions
      const waitpoint = await resolveWaitpointThroughReadThrough({
        waitpointId,
        environmentId: authentication.environment.id,
        read: (client: PrismaReplicaClient) =>
          client.waitpoint.findFirst({
            // runops-routed-ok: resolveWaitpointThroughReadThrough legacy leg
            where: {
              id: waitpointId,
              environmentId: authentication.environment.id,
            },
          }),
      });

      if (!waitpoint) {
        // Retryable: a miss here can be replica lag. resolveWaitpointThroughReadThrough
        // deliberately does not read the legacy primary, so it relies on the caller retrying.
        // A plain 404 is not retried by the SDK, which would turn a transient miss into a
        // permanent failure.
        throw json(
          { error: "Waitpoint not found" },
          { status: 404, headers: { "x-should-retry": "true" } }
        );
      }

      const _result = await engine.blockRunWithWaitpoint({
        runId,
        waitpoints: [waitpointId],
        projectId: authentication.environment.project.id,
        organizationId: authentication.environment.organization.id,
      });

      return json<WaitForWaitpointTokenResponseBody>(
        {
          success: true,
        },
        { status: 200 }
      );
    } catch (error) {
      // A Response thrown inside the try is a deliberate status (the 404 above), not a
      // failure. Re-throw it untouched, or every intentional 4xx here becomes a 500.
      if (error instanceof Response) {
        throw error;
      }
      logger.error("Failed to wait for waitpoint", { runId, waitpointId, error });
      throw json({ error: "Failed to wait for waitpoint token" }, { status: 500 });
    }
  }
);

export { action };
