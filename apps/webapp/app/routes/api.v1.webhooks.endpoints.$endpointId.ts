import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { findWebhookEndpointResource } from "~/presenters/v3/ApiWebhookEndpointPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  endpointId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, authentication) =>
      findWebhookEndpointResource(authentication, params.endpointId),
    authorization: {
      action: "read",
      resource: () => ({ type: "webhooks" }),
    },
  },
  async ({ resource }) => {
    return json(resource);
  }
);
