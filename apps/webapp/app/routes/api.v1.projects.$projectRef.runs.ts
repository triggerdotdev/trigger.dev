import { json ,type  LoaderFunctionArgs  } from "@remix-run/server-runtime";
import { z } from "zod";
import { ValidationError } from "zod-validation-error";
import { findProjectByRef } from "~/models/project.server";
import { ApiRunListPresenter } from "~/presenters/v3/ApiRunListPresenter.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { apiCors } from "~/utils/apiCors";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return apiCors(request, json({}));
  }

  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return apiCors(request, json({ error: "Invalid or Missing API key" }, { status: 401 }));
  }

  const $params = ParamsSchema.safeParse(params);

  if (!$params.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  const project = await findProjectByRef($params.data.projectRef, authenticationResult.userId);

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const url = new URL(request.url);

  const presenter = new ApiRunListPresenter();

  try {
    const result = await presenter.call(project, url.searchParams);

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
