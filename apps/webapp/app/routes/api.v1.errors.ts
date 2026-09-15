import { json } from "@remix-run/server-runtime";
import {
  ApiErrorListPresenter,
  ApiErrorListSearchParams,
} from "~/presenters/v3/ApiErrorListPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    searchParams: ApiErrorListSearchParams,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: () => ({ type: "errors" }),
    },
    findResource: async () => 1, // Collection route — nothing to resolve.
  },
  async ({ searchParams, authentication }) => {
    const presenter = new ApiErrorListPresenter();
    const result = await presenter.call(
      authentication.environment.project,
      authentication.environment,
      searchParams
    );

    return json(result);
  }
);
