import { json ,type  ActionFunctionArgs  } from "@remix-run/server-runtime";
import { EphemeralEventDispatcherRequestBodySchema , InvokeJobRequestBodySchema } from '@trigger.dev/core/schemas';
import { z } from "zod";
import { PrismaErrorSchema } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { CreateEphemeralEventDispatcherService } from "~/services/dispatchers/createEphemeralEventDispatcher.server";
import { InvokeJobService } from "~/services/jobs/invokeJob.server";
import { logger } from "~/services/logger.server";

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

  // Now parse the request body
  const anyBody = await request.json();

  logger.debug("CreateEphemeralEventDispatcherService.call() request body", {
    body: anyBody,
  });

  const body = EphemeralEventDispatcherRequestBodySchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new CreateEphemeralEventDispatcherService();

  try {
    const dispatcher = await service.call(authenticationResult.environment, body.data);

    if (!dispatcher) {
      return json({ error: "Could not create Event Dispatcher" }, { status: 500 });
    }

    return json({ id: dispatcher.id });
  } catch (error) {
    const prismaError = PrismaErrorSchema.safeParse(error);
    // Record not found in the database
    if (prismaError.success && prismaError.data.code === "P2005") {
      return json({ error: "Dispatcher not found" }, { status: 404 });
    } else {
      return json({ error: "Internal Server Error" }, { status: 500 });
    }
  }
}
