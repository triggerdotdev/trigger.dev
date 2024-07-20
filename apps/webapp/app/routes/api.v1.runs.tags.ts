import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { ValidationError } from "zod-validation-error";
import { ApiRunTagListPresenter } from "~/presenters/v3/ApiRunTagListPresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { apiCors } from "~/utils/apiCors";

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return apiCors(request, json({}));
  }

  const authenticationResult = await authenticateApiRequest(request, {
    allowPublicKey: false,
  });

  if (!authenticationResult) {
    return apiCors(request, json({ error: "Invalid or Missing API key" }, { status: 401 }));
  }

  const authenticatedEnv = authenticationResult.environment;

  const url = new URL(request.url);

  const presenter = new ApiRunTagListPresenter();

  try {
    const result = await presenter.call(
      authenticatedEnv.project,
      url.searchParams,
      authenticatedEnv
    );

    if (!result) {
      return apiCors(request, json({ data: [] }));
    }

    return apiCors(request, json(result));
  } catch (error) {
    if (error instanceof ValidationError) {
      return apiCors(
        request,
        json({ error: "Query Error", details: error.details }, { status: 400 })
      );
    } else {
      return apiCors(
        request,
        json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
      );
    }
  }
}
