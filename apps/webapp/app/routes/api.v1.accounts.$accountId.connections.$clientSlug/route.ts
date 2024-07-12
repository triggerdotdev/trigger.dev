import { json ,type  ActionFunctionArgs  } from "@remix-run/server-runtime";
import { CreateExternalConnectionBodySchema , ErrorWithStackSchema } from '@trigger.dev/core/schemas';
import { z } from "zod";
import { generateErrorMessage } from "zod-error";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { CreateExternalConnectionService } from "./CreateExternalConnectionService.server";

const ParamsSchema = z.object({
  accountId: z.string(),
  clientSlug: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ message: generateErrorMessage(parsedParams.error.issues) }, { status: 422 });
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  // Now parse the request body
  const anyBody = await request.json();

  const body = CreateExternalConnectionBodySchema.safeParse(anyBody);

  if (!body.success) {
    return json({ message: generateErrorMessage(body.error.issues) }, { status: 422 });
  }

  try {
    const service = new CreateExternalConnectionService();

    const connection = await service.call(
      parsedParams.data.accountId,
      parsedParams.data.clientSlug,
      authenticatedEnv,
      body.data
    );

    return json(connection);
  } catch (error) {
    const parsedError = ErrorWithStackSchema.safeParse(error);

    if (!parsedError.success) {
      return json({ message: "Unknown error" }, { status: 500 });
    }

    return json({ message: parsedError.data.message }, { status: 500 });
  }
}
