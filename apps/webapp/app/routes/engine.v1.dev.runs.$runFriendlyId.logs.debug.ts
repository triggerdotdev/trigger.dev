import { TypedResponse } from "@remix-run/server-runtime";
import { assertExhaustive } from "@trigger.dev/core/utils";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import {
  WorkerApiDebugLogBody,
  WorkerApiRunAttemptStartResponseBody,
} from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { recordRunDebugLog } from "~/v3/eventRepository/eventRepository.server";

// const { action } = createActionApiRoute(
//   {
//     params: z.object({
//       runFriendlyId: z.string(),
//     }),
//     body: WorkerApiDebugLogBody,
//     method: "POST",
//   },
//   async ({
//     authentication,
//     body,
//     params,
//   }): Promise<TypedResponse<WorkerApiRunAttemptStartResponseBody>> => {
//     const { runFriendlyId } = params;

//     try {
//       const run = await prisma.taskRun.findFirst({
//         where: {
//           friendlyId: params.runFriendlyId,
//           runtimeEnvironmentId: authentication.environment.id,
//         },
//       });

//       if (!run) {
//         throw new Response("You don't have permissions for this run", { status: 401 });
//       }

//       const eventResult = await recordRunDebugLog(
//         RunId.fromFriendlyId(runFriendlyId),
//         body.message,
//         {
//           attributes: {
//             properties: body.properties,
//           },
//           startTime: body.time,
//         }
//       );

//       if (eventResult.success) {
//         return new Response(null, { status: 204 });
//       }

//       switch (eventResult.code) {
//         case "FAILED_TO_RECORD_EVENT":
//           return new Response(null, { status: 400 }); // send a 400 to prevent retries
//         case "RUN_NOT_FOUND":
//           return new Response(null, { status: 404 });
//         default:
//           return assertExhaustive(eventResult.code);
//       }
//     } catch (error) {
//       logger.error("Failed to record dev log", {
//         environmentId: authentication.environment.id,
//         error,
//       });
//       throw error;
//     }
//   }
// );

// export { action };

// Create a generic JSON action in remix
export function action() {
  return new Response(null, { status: 204 });
}
