import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { parsePacket, UpdateMetadataRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { handleMetadataPacket } from "~/utils/packets";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { isFinalRunStatus } from "~/v3/taskStatus";

const ParamsSchema = z.object({
  runId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a PUT request
  if (request.method.toUpperCase() !== "PUT") {
    return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "PUT" } });
  }

  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return json(
      { error: "Invalid request parameters", issues: parsedParams.error.issues },
      { status: 400 }
    );
  }

  try {
    const anyBody = await request.json();

    const body = UpdateMetadataRequestBody.safeParse(anyBody);

    if (!body.success) {
      return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
    }

    const metadataPacket = handleMetadataPacket(
      body.data.metadata,
      body.data.metadataType ?? "application/json"
    );

    if (!metadataPacket) {
      return json({ error: "Invalid metadata" }, { status: 400 });
    }

    const taskRun = await prisma.taskRun.findFirst({
      where: {
        friendlyId: parsedParams.data.runId,
        runtimeEnvironmentId: authenticationResult.environment.id,
      },
      select: {
        status: true,
      },
    });

    if (!taskRun) {
      return json({ error: "Task Run not found" }, { status: 404 });
    }

    if (isFinalRunStatus(taskRun.status)) {
      return json({ error: "Cannot update metadata for a completed run" }, { status: 400 });
    }

    await prisma.taskRun.update({
      where: {
        friendlyId: parsedParams.data.runId,
        runtimeEnvironmentId: authenticationResult.environment.id,
      },
      data: {
        metadata: metadataPacket?.data,
        metadataType: metadataPacket?.dataType,
      },
    });

    const parsedPacket = await parsePacket(metadataPacket);

    return json({ metadata: parsedPacket }, { status: 200 });
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return json({ error: error.message }, { status: error.status ?? 422 });
    } else {
      return json(
        { error: error instanceof Error ? error.message : "Internal Server Error" },
        { status: 500 }
      );
    }
  }
}
