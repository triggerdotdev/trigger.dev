import { json } from "@remix-run/server-runtime";
import {
  ApiBatchListPresenter,
  ApiBatchListSearchParams,
} from "~/presenters/v3/ApiBatchListPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    searchParams: ApiBatchListSearchParams,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: () => ({ type: "runs" }),
    },
    findResource: async () => 1,
  },
  async ({ searchParams, authentication }) => {
    const presenter = new ApiBatchListPresenter();
    const result = await presenter.call(authentication.environment, searchParams);
    return json(result);
  }
);
