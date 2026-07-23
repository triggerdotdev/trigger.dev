import { json } from "@remix-run/server-runtime";
import {
  ApiWebhookDeliveryListPresenter,
  ApiWebhookDeliveryListSearchParams,
} from "~/presenters/v3/ApiWebhookDeliveryPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    searchParams: ApiWebhookDeliveryListSearchParams,
    findResource: async () => 1, // Collection route — nothing to resolve.
    allowJWT: true,
    corsStrategy: "all",
    authorization: { action: "read", resource: () => ({ type: "webhooks" }) },
  },
  async ({ searchParams, authentication }) => {
    const presenter = new ApiWebhookDeliveryListPresenter();
    const result = await presenter.call(authentication.environment, searchParams);

    return json(result);
  }
);
