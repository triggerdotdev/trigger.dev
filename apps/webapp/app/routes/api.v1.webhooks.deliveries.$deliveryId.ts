import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { findWebhookDeliveryResource } from "~/presenters/v3/ApiWebhookDeliveryPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  deliveryId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, authentication) =>
      findWebhookDeliveryResource(authentication, params.deliveryId),
    authorization: {
      action: "read",
      resource: () => ({ type: "webhooks" }),
    },
  },
  async ({ resource }) => {
    return json(resource);
  }
);
