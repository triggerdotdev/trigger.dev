import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  type CompleteWaitpointTokenResponseBody,
  conditionallyExportPacket,
  stringifyIO,
} from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { verifyHttpCallbackHash } from "~/services/httpCallback.server";
import { logger } from "~/services/logger.server";
import { engine } from "~/v3/runEngine.server";

const paramsSchema = z.object({
  waitpointFriendlyId: z.string(),
  hash: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const contentLength = request.headers.get("content-length");
  if (!contentLength) {
    return json({ error: "Content-Length header is required" }, { status: 411 });
  }

  if (parseInt(contentLength) > env.TASK_PAYLOAD_MAXIMUM_SIZE) {
    return json({ error: "Request body too large" }, { status: 413 });
  }

  const { waitpointFriendlyId, hash } = paramsSchema.parse(params);
  const waitpointId = WaitpointId.toId(waitpointFriendlyId);

  try {
    const waitpoint = await $replica.waitpoint.findFirst({
      where: {
        id: waitpointId,
      },
      include: {
        environment: {
          select: {
            apiKey: true,
          },
        },
      },
    });

    if (!waitpoint) {
      return json({ error: "Waitpoint not found" }, { status: 404 });
    }

    if (!verifyHttpCallbackHash(waitpoint.id, hash, waitpoint.environment.apiKey)) {
      return json({ error: "Invalid URL, hash doesn't match" }, { status: 401 });
    }

    if (waitpoint.status === "COMPLETED") {
      return json<CompleteWaitpointTokenResponseBody>({
        success: true,
      });
    }

    // If the request body is not valid JSON, return an empty object
    const body = await request.json().catch(() => ({}));

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
    logger.error("Failed to complete HTTP callback", { error });
    throw json({ error: "Failed to complete HTTP callback" }, { status: 500 });
  }
}
