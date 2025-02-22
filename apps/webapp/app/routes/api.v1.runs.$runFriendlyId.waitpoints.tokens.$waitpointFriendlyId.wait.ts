import { json } from "@remix-run/server-runtime";
import {
  CompleteWaitpointTokenRequestBody,
  CompleteWaitpointTokenResponseBody,
  conditionallyExportPacket,
  CreateWaitpointTokenResponseBody,
  stringifyIO,
  WaitForWaitpointTokenRequestBody,
  WaitForWaitpointTokenResponseBody,
} from "@trigger.dev/core/v3";
import { RunId, WaitpointId } from "@trigger.dev/core/v3/apps";
import { z } from "zod";
import { $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { parseDelay } from "~/utils/delays";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { engine } from "~/v3/runEngine.server";

const { action } = createActionApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
      waitpointFriendlyId: z.string(),
    }),
    body: WaitForWaitpointTokenRequestBody,
    maxContentLength: 1024 * 10, // 10KB
    method: "POST",
  },
  async ({ authentication, body, params }) => {
    // Resume tokens are actually just waitpoints
    const waitpointId = WaitpointId.toId(params.waitpointFriendlyId);
    const runId = RunId.toId(params.runFriendlyId);

    const timeout = await parseDelay(body.timeout);

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
        environmentId: authentication.environment.id,
        projectId: authentication.environment.project.id,
        failAfter: timeout,
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
