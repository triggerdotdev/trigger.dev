import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { DeployBackgroundTaskRequestBodySchema } from "@trigger.dev/core";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { DeployBackgroundTaskService } from "~/services/backgroundTasks/deployBackgroundTask.server";

export async function action({ request, params }: ActionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  // Now parse the request body
  const anyBody = await request.json();

  const body = DeployBackgroundTaskRequestBodySchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new DeployBackgroundTaskService();

  try {
    const results = await service.call(authenticationResult.environment, body.data);

    if (!results) {
      return json(
        {
          error: `Unable to deploy background task, Task with ID = ${body.data.id} not found`,
        },
        { status: 500 }
      );
    }

    const { artifact, imageConfig } = results;

    return json({
      id: artifact.id,
      hash: artifact.hash,
      image: imageConfig.image,
      tag: imageConfig.tag,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    });
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
