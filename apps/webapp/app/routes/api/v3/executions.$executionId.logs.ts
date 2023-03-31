import type { Organization, RuntimeEnvironment } from ".prisma/client";
import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { LogMessage } from "@trigger.dev/internal";
import { LogMessageSchema } from "@trigger.dev/internal";
import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger";

const ParamsSchema = z.object({
  executionId: z.string(),
});

export async function action({ request, params }: ActionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticatedEnv = await authenticateApiRequest(request);

  if (!authenticatedEnv) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const { executionId } = ParamsSchema.parse(params);

  // Now parse the request body
  const anyBody = await request.json();

  const body = LogMessageSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new CreateExecutionLogService();

  try {
    const log = await service.call(
      authenticatedEnv,
      authenticatedEnv.organization,
      executionId,
      body.data
    );

    return json(log);
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}

export class CreateExecutionLogService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: RuntimeEnvironment,
    organization: Organization,
    executionId: string,
    logMessage: LogMessage
  ) {
    logger.debug(logMessage.message, logMessage.data ?? {});

    return logMessage;
  }
}
