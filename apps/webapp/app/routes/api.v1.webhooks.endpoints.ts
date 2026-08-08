import { json } from "@remix-run/server-runtime";
import {
  ApiWebhookEndpointListPresenter,
  ApiWebhookEndpointListSearchParams,
} from "~/presenters/v3/ApiWebhookEndpointPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    searchParams: ApiWebhookEndpointListSearchParams,
    findResource: async () => 1, // Collection route — nothing to resolve.
    allowJWT: true,
    corsStrategy: "all",
    authorization: { action: "read", resource: () => ({ type: "webhooks" }) },
  },
  async ({ searchParams, authentication }) => {
    const presenter = new ApiWebhookEndpointListPresenter();
    const result = await presenter.call(authentication.environment, searchParams);

    return json(result);
  }
);
