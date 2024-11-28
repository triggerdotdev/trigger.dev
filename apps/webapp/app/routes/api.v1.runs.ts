import { json } from "@remix-run/server-runtime";
import {
  ApiRunListPresenter,
  ApiRunListSearchParams,
} from "~/presenters/v3/ApiRunListPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    searchParams: ApiRunListSearchParams,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (_, searchParams) => ({ tasks: searchParams["filter[taskIdentifier]"] }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ searchParams, authentication }) => {
    const presenter = new ApiRunListPresenter();
    const result = await presenter.call(
      authentication.environment.project,
      searchParams,
      authentication.environment
    );

    return json(result);
  }
);
