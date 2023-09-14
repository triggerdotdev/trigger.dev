import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { CreateBackgroundTaskImageRequestBodySchema } from "@trigger.dev/core";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { CreateBackgroundTaskImageService } from "~/services/backgroundTasks/createBackgroundTaskImage.server";

const ParamsSchema = z.object({
  id: z.string(),
});

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

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid request params" }, { status: 400 });
  }

  // Now parse the request body
  const anyBody = await request.json();

  const body = CreateBackgroundTaskImageRequestBodySchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new CreateBackgroundTaskImageService();

  try {
    const image = await service.call(
      authenticationResult.environment,
      parsedParams.data.id,
      body.data
    );

    if (!image) {
      return json(
        {
          error: `Unable to create background task image`,
        },
        { status: 500 }
      );
    }

    return json(image);
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
