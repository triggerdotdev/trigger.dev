import { json } from "@remix-run/server-runtime";
import { type WaitForWaitpointTokenResponseBody } from "@trigger.dev/core/v3";
import { RunId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
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
      const waitpoint = await $replica.waitpoint.findFirst({
        where: {
          id: waitpointId,
          environmentId: authentication.environment.id,
        },
      });

      if (!waitpoint) {
        throw json({ error: "Waitpoint not found" }, { status: 404 });
      }

      const result = await engine.blockRunWithWaitpoint({
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
      logger.error("Failed to wait for waitpoint", { runId, waitpointId, error });
      throw json({ error: "Failed to wait for waitpoint token" }, { status: 500 });
    }
  }
);

export { action };
