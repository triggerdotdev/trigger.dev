import { json } from "@remix-run/server-runtime";
import {
  CompleteWaitpointTokenRequestBody,
  type CompleteWaitpointTokenResponseBody,
  stringifyIO,
} from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import {
  $replica,
  type PrismaReplicaClient,
  runOpsNewReplica,
  runOpsSplitReadEnabled,
} from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { processWaitpointCompletionPacket } from "~/runEngine/concerns/waitpointCompletionPacket.server";
import { resolveWaitpointThroughReadThrough } from "~/runEngine/concerns/resolveWaitpointThroughReadThrough.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { engine } from "~/v3/runEngine.server";

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
      // Resolve wherever the waitpoint resides: a standalone token lives on the control-plane
      // store, while a run-owned waitpoint co-locates with its run. Fan-out reads the run-ops
      // replica first, then the control-plane replica so both residencies resolve, gated on the
      // URL-presence read gate so the fan-out spans both DBs independent of the mint flag.
      const waitpoint = await resolveWaitpointThroughReadThrough({
        waitpointId,
        environmentId: authentication.environment.id,
        read: (client: PrismaReplicaClient) =>
          client.waitpoint.findFirst({
            where: {
              id: waitpointId,
              environmentId: authentication.environment.id,
            },
          }),
        deps: {
          newClient: runOpsNewReplica,
          legacyReplica: $replica,
          splitEnabled: runOpsSplitReadEnabled,
        },
      });

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

      const _result = await engine.completeWaitpoint({
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
