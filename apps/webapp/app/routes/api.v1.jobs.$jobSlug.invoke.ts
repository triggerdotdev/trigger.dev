import { json ,type  ActionFunctionArgs  } from "@remix-run/server-runtime";
import { InvokeJobRequestBodySchema } from '@trigger.dev/core/schemas';
import { z } from "zod";
import { PrismaErrorSchema } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { InvokeJobService } from "~/services/jobs/invokeJob.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  jobSlug: z.string(),
});

const HeadersSchema = z.object({
  "idempotency-key": z.string().optional().nullable(),
  "trigger-version": z.string().optional().nullable(),
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
    return json({ error: "Invalid or Missing jobSlug" }, { status: 400 });
  }

  const { jobSlug } = parsed.data;

  const headers = HeadersSchema.safeParse(Object.fromEntries(request.headers));

  if (!headers.success) {
    return json({ error: "Invalid headers" }, { status: 400 });
  }

  const { "idempotency-key": idempotencyKey, "trigger-version": triggerVersion } = headers.data;

  // Now parse the request body
  const anyBody = await request.json();

  logger.debug("InvokeJobService.call() request body", {
    body: anyBody,
    jobSlug,
    idempotencyKey,
    triggerVersion,
  });

  const body = InvokeJobRequestBodySchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new InvokeJobService();

  try {
    const run = await service.call(
      authenticationResult.environment,
      jobSlug,
      body.data,
      idempotencyKey ?? undefined
    );

    if (!run) {
      return json({ error: "Job could not be invoked" }, { status: 500 });
    }

    return json({ id: run.id });
  } catch (error) {
    const prismaError = PrismaErrorSchema.safeParse(error);
    // Record not found in the database
    if (prismaError.success && prismaError.data.code === "P2005") {
      return json({ error: "Job not found" }, { status: 404 });
    } else {
      return json({ error: "Internal Server Error" }, { status: 500 });
    }
  }
}
