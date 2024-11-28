import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { ApiRetrieveBatchPresenter } from "~/presenters/v3/ApiRetrieveBatchPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  batchId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (params) => ({ batch: params.batchId }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ params, authentication }) => {
    const presenter = new ApiRetrieveBatchPresenter();
    const result = await presenter.call(params.batchId, authentication.environment);

    if (!result) {
      return json({ error: "Batch not found" }, { status: 404 });
    }

    return json(result);
  }
);
