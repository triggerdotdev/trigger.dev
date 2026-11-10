import { json } from "@remix-run/server-runtime";
import { MAX_INLINE_COMPLETION_OUTPUT_BYTES } from "@internal/run-engine";
import {
  CompleteWaitpointTokenRequestBody,
  type CompleteWaitpointTokenResponseBody,
  stringifyIO,
} from "@trigger.dev/core/v3";
import { parseWaitpointId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { processWaitpointCompletionPacket } from "~/runEngine/concerns/waitpointCompletionPacket.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { unroutableIdResponse } from "~/services/routeBuilders/unroutableId.server";
import { engine } from "~/v3/runEngine.server";
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
      const parsed = (await engine.waitpointSystem.isWaitpointStoreEnabled(
        authentication.environment.organization.id
      ))
        ? parseWaitpointId(waitpointId)
        : undefined;
      let waitpoint;
      if (
        parsed &&
        parsed.format !== "legacy" &&
        (parsed.type === "DATETIME" || parsed.type === "MANUAL")
      ) {
        waitpoint = await engine.getStoreDateTimeWaitpoint({
          waitpointId,
          environmentId: authentication.environment.id,
          projectId: authentication.environment.project.id,
          organizationId: authentication.environment.organization.id,
        });
      } else {
        waitpoint = await runStore.findWaitpoint({
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
      const pathPrefix = `${WaitpointId.toFriendlyId(waitpointId)}/token`;
      const finalData = await processWaitpointCompletionPacket(
        stringifiedData,
        authentication.environment,
        // A losing native completion must not replace the object referenced by the winner.
        parsed &&
          parsed.format !== "legacy" &&
          (parsed.type === "DATETIME" || parsed.type === "MANUAL")
          ? `${pathPrefix}/${crypto.randomUUID()}`
          : pathPrefix,
        parsed &&
          parsed.format !== "legacy" &&
          (parsed.type === "DATETIME" || parsed.type === "MANUAL")
          ? MAX_INLINE_COMPLETION_OUTPUT_BYTES
          : undefined
      );

      const completionInput: Parameters<typeof engine.completeWaitpoint>[0] = {
        id: waitpointId,
        output: finalData.data
          ? { type: finalData.dataType, value: finalData.data, isError: false }
          : undefined,
        organizationId: authentication.environment.organization.id,
      };
      if (
        parsed &&
        parsed.format !== "legacy" &&
        (parsed.type === "DATETIME" || parsed.type === "MANUAL")
      )
        completionInput.onlyIfPending = true;
      const _result = await engine.completeWaitpoint(completionInput);

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
          environmentId: authentication.environment.id,
        });
        throw unroutable;
      }

      logger.error("Failed to complete waitpoint token", {
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error,
        environmentId: authentication.environment.id,
      });
      throw json({ error: "Failed to complete waitpoint token" }, { status: 500 });
    }
  }
);

export { action, loader };
