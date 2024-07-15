import { json ,type  ActionFunctionArgs  } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { CancelTaskRunService } from "~/v3/services/cancelTaskRun.server";

const ParamsSchema = z.object({
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
    return json({ error: "Invalid or Missing run id" }, { status: 400 });
  }

  const { runParam } = parsed.data;

  const taskRun = await prisma.taskRun.findUnique({
    where: {
      friendlyId: runParam,
      runtimeEnvironmentId: authenticationResult.environment.id,
    },
  });

  if (!taskRun) {
    return json({ error: "Run not found" }, { status: 404 });
  }

  const service = new CancelTaskRunService();

  try {
    await service.call(taskRun);
  } catch (error) {
    return json({ error: "Internal Server Error" }, { status: 500 });
  }

  return json({ id: runParam }, { status: 200 });
}
