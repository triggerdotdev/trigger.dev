import { json ,type  LoaderFunctionArgs  } from "@remix-run/server-runtime";
import { z } from "zod";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { apiCors } from "~/utils/apiCors";

const ParamsSchema = z.object({
  runId: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return apiCors(request, json({}));
  }

  const authenticationResult = await authenticateApiRequest(request, {
    allowPublicKey: true,
  });
  if (!authenticationResult) {
    return apiCors(request, json({ error: "Invalid or Missing API key" }, { status: 401 }));
  }

  const authenticatedEnv = authenticationResult.environment;

  const parsed = ParamsSchema.safeParse(params);

  if (!parsed.success) {
    return apiCors(request, json({ error: "Invalid or missing runId" }, { status: 400 }));
  }

  const { runId } = parsed.data;

  const showSecretDetails = authenticationResult.type === "PRIVATE";

  const presenter = new ApiRetrieveRunPresenter();
  const result = await presenter.call(runId, authenticatedEnv, showSecretDetails);

  if (!result) {
    return apiCors(request, json({ error: "Run not found" }, { status: 404 }));
  }

  return apiCors(request, json(result));
}
