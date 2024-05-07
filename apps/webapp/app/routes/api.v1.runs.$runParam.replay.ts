import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ReplayTaskRunService } from "~/v3/services/replayTaskRun.server";

const ParamsSchema = z.object({
  /* This is the run friendly ID */
  runParam: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return json({ error: "Invalid or missing run ID" }, { status: 400 });
  }

  const { runParam } = parsed.data;

  try {
    const taskRun = await prisma.taskRun.findUnique({
      where: {
        friendlyId: runParam,
      },
    });

    if (!taskRun) {
      return json({ error: "Run not found" }, { status: 404 });
    }

    const service = new ReplayTaskRunService();
    const newRun = await service.call(taskRun);

    if (!newRun) {
      return json({ error: "Failed to create new run" }, { status: 400 });
    }

    return json({
      id: newRun?.friendlyId,
    });
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to replay run", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
        run: runParam,
      });
      return json({ error: error.message }, { status: 400 });
    } else {
      logger.error("Failed to replay run", { error: JSON.stringify(error), run: runParam });
      return json({ error: JSON.stringify(error) }, { status: 400 });
    }
  }
}
