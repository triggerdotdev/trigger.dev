import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { findErrorGroupResource } from "~/presenters/v3/ApiErrorGroupPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  errorId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, authentication) =>
      findErrorGroupResource(authentication, params.errorId),
    authorization: {
      action: "read",
      resource: (_resource, params) => ({ type: "errors", id: params.errorId }),
    },
  },
  async ({ resource }) => {
    return json(resource);
  }
);
