import { json } from "@remix-run/server-runtime";
import {
  CompleteWaitpointTokenRequestBody,
  type CompleteWaitpointTokenResponseBody,
  stringifyIO,
} from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { processWaitpointCompletionPacket } from "~/runEngine/concerns/waitpointCompletionPacket.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { unroutableIdResponse } from "~/services/routeBuilders/unroutableId.server";
import { completeWaitpointWithGuard } from "~/v3/completeWaitpointWithGuard.server";
import { runStore } from "~/v3/runStore.server";

const { action, loader } = createActionApiRoute(
  {
    params: z.object({
      waitpointFriendlyId: z.string(),
    }),
    body: CompleteWaitpointTokenRequestBody,
    maxContentLength: env.TASK_PAYLOAD_MAXIMUM_SIZE,
    allowJWT: true,
    authorization: {
      action: "write",
      resource: (params) => ({ type: "waitpoints", id: params.waitpointFriendlyId }),
    },
    corsStrategy: "all",
  },
  async ({ authentication, body, params }) => {
    // Resume tokens are actually just waitpoints
    const waitpointId = WaitpointId.toId(params.waitpointFriendlyId);

    try {
      //check permissions
      // The store routes by the waitpointId's residency (id shape) and probes both stores, so a
      // standalone token and a run-owned co-located waitpoint both resolve off the owning replica.
      let waitpoint = await runStore.findWaitpoint({
        where: {
          id: waitpointId,
          environmentId: authentication.environment.id,
        },
      });

      if (!waitpoint) {
        // Read-your-writes: a token completed right after mint may not have replicated yet.
        waitpoint = await runStore.findWaitpointOnPrimary({
          where: {
            id: waitpointId,
            environmentId: authentication.environment.id,
          },
        });
      }

      if (!waitpoint) {
        throw json({ error: "Waitpoint not found" }, { status: 404 });
      }

      if (waitpoint.status === "COMPLETED") {
        return json<CompleteWaitpointTokenResponseBody>({
          success: true,
        });
      }

      const stringifiedData = await stringifyIO(body.data);
      const finalData = await processWaitpointCompletionPacket(
        stringifiedData,
        authentication.environment,
        `${WaitpointId.toFriendlyId(waitpointId)}/token`
      );

      await completeWaitpointWithGuard({
        id: waitpointId,
        output: finalData.data
          ? { type: finalData.dataType, value: finalData.data, isError: false }
          : undefined,
      });

      return json<CompleteWaitpointTokenResponseBody>(
        {
          success: true,
        },
        { status: 200 }
      );
    } catch (error) {
      // Re-throw Response objects (intentional HTTP responses like the 404 above) so the
      // client gets the correct status code instead of a 500, and we don't log them as errors.
      if (error instanceof Response) throw error;

      // A caller-supplied id naming a shard this topology has no store for cannot be routed,
      // so it is a 404 like an absent token — not the 500 this catch would otherwise answer.
      const unroutable = unroutableIdResponse(error);
      if (unroutable) {
        // Logged so a shard key dropped from an append-only config still alarms, rather than
        // every live token on it quietly answering "not found".
        logger.warn("Unroutable waitpoint id on token completion", {
          waitpointFriendlyId: params.waitpointFriendlyId,
          error: error instanceof Error ? error.message : error,
        });
        throw unroutable;
      }

      logger.error("Failed to complete waitpoint token", {
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error,
      });
      throw json({ error: "Failed to complete waitpoint token" }, { status: 500 });
    }
  }
);

export { action, loader };
