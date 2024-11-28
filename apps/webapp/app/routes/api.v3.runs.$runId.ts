import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (params) => ({ runs: params.runId }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ params, authentication }) => {
    const presenter = new ApiRetrieveRunPresenter();
    const result = await presenter.call(params.runId, authentication.environment);

    if (!result) {
      return json({ error: "Run not found" }, { status: 404 });
    }

    return json(result);
  }
);
