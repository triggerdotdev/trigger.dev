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
import { logger } from "~/services/logger.server";
import { engine } from "~/v3/runEngine.server";

const paramsSchema = z.object({
  waitpointFriendlyId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > env.TASK_PAYLOAD_MAXIMUM_SIZE) {
    return json({ error: "Request body too large" }, { status: 413 });
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

    let body;
    try {
      body = await readJsonWithLimit(request, env.TASK_PAYLOAD_MAXIMUM_SIZE);
    } catch (e) {
      return json({ error: "Request body too large" }, { status: 413 });
    }

    if (!body) {
      body = {};
    }

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

async function readJsonWithLimit(request: Request, maxSize: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("No body");
  let received = 0;
  let chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxSize) {
      throw new Error("Request body too large");
    }
    chunks.push(value);
  }
  const full = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    full.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder().decode(full);
  return JSON.parse(text);
}
