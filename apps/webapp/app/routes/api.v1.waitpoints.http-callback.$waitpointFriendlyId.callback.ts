import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  type CompleteWaitpointTokenResponseBody,
  conditionallyExportPacket,
  stringifyIO,
} from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import { engine } from "~/v3/runEngine.server";

const paramsSchema = z.object({
  waitpointFriendlyId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const { waitpointFriendlyId } = paramsSchema.parse(params);
  const waitpointId = WaitpointId.toId(waitpointFriendlyId);

  try {
    //check permissions
    const waitpoint = await $replica.waitpoint.findFirst({
      where: {
        id: waitpointId,
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

    const body = await request.json();

    const stringifiedData = await stringifyIO(body);
    const finalData = await conditionallyExportPacket(
      stringifiedData,
      `${waitpointId}/waitpoint/http-callback`
    );

    const result = await engine.completeWaitpoint({
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
    logger.error("Failed to complete waitpoint token", { error });
    throw json({ error: "Failed to complete waitpoint token" }, { status: 500 });
  }
}
