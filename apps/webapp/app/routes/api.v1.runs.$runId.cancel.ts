import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { PrismaErrorSchema } from "~/db.server";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { CancelRunService } from "~/services/runs/cancelRun.server";
import { ApiRunPresenter } from "~/presenters/ApiRunPresenter.server";

const ParamsSchema = z.object({
  runId: z.string(),
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
    return json({ error: "Invalid or Missing runId" }, { status: 400 });
  }

  const { runId } = parsed.data;

  const service = new CancelRunService();
  try {
    await service.call({ runId });
  } catch (error) {
    const prismaError = PrismaErrorSchema.safeParse(error);
    // Record not found in the database
    if (prismaError.success && prismaError.data.code === "P2005") {
      return json({ error: "Run not found" }, { status: 404 });
    } else {
      return json({ error: "Internal Server Error" }, { status: 500 });
    }
  }

  const presenter = new ApiRunPresenter();
  const jobRun = await presenter.call({
    runId: runId,
  });

  if (!jobRun) {
    return json({ message: "Run not found" }, { status: 404 });
  }

  return json({
    id: jobRun.id,
    status: jobRun.status,
    startedAt: jobRun.startedAt,
    updatedAt: jobRun.updatedAt,
    completedAt: jobRun.completedAt,
    output: jobRun.output,
    tasks: jobRun.tasks,
    statuses: jobRun.statuses.map((s) => ({
      ...s,
      state: s.state ?? undefined,
      data: s.data ?? undefined,
      history: s.history ?? undefined,
    })),
  });
}
