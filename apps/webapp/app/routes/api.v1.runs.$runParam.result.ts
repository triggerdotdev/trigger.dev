import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { ApiRunResultPresenter } from "~/presenters/v3/ApiRunResultPresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  /* This is the run friendly ID */
  runParam: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const parsed = ParamsSchema.safeParse(params);

  if (!parsed.success) {
    return json({ error: "Invalid or missing run ID" }, { status: 400 });
  }

  const { runParam } = parsed.data;

  try {
    const presenter = new ApiRunResultPresenter();
    const result = await presenter.call(runParam, authenticationResult.environment);

    if (!result) {
      return json({ error: "Run either doesn't exist or is not finished" }, { status: 404 });
    }

    return json(result);
  } catch (error) {
    logger.error("Failed to load run result", { error });
    return json({ error: "Something went wrong, please try again." }, { status: 500 });
  }
}
