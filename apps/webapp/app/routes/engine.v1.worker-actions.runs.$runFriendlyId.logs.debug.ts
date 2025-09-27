import { assertExhaustive } from "@trigger.dev/core/utils";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { WorkerApiDebugLogBody } from "@trigger.dev/core/v3/runEngineWorker";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { recordRunDebugLog } from "~/v3/eventRepository/index.server";

export const action = createActionWorkerApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
    }),
    body: WorkerApiDebugLogBody,
  },
  async ({ body, params }): Promise<Response> => {
    const { runFriendlyId } = params;

    const eventResult = await recordRunDebugLog(RunId.fromFriendlyId(runFriendlyId), body.message, {
      attributes: {
        properties: body.properties,
      },
      startTime: body.time,
    });

    if (eventResult.success) {
      return new Response(null, { status: 204 });
    }

    switch (eventResult.code) {
      case "FAILED_TO_RECORD_EVENT":
        return new Response(null, { status: 400 }); // send a 400 to prevent retries
      case "RUN_NOT_FOUND":
        return new Response(null, { status: 404 });
      default:
        return assertExhaustive(eventResult.code);
    }
  }
);
