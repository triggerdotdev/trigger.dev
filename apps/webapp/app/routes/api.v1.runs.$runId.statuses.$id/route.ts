import { json ,type  ActionFunctionArgs  } from "@remix-run/server-runtime";
import { JobRunStatusRecordSchema , StatusUpdateSchema } from '@trigger.dev/core/schemas';
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { SetStatusService } from "./SetStatusService.server";

const ParamsSchema = z.object({
  runId: z.string(),
  id: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "PUT") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const { runId, id } = ParamsSchema.parse(params);

  // Now parse the request body
  const anyBody = await request.json();

  logger.debug("SetStatusService.call() request body", {
    body: anyBody,
    runId,
    id,
  });

  const body = StatusUpdateSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new SetStatusService();

  try {
    const statusRecord = await service.call(runId, id, body.data);

    logger.debug("SetStatusService.call() response body", {
      runId,
      id,
      statusRecord,
    });

    if (!statusRecord) {
      return json({ error: "Something went wrong" }, { status: 500 });
    }

    const status = JobRunStatusRecordSchema.parse({
      ...statusRecord,
      state: statusRecord.state ?? undefined,
      history: statusRecord.history ?? undefined,
      data: statusRecord.data ?? undefined,
    });

    return json(status);
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
