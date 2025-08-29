import { json } from "@remix-run/server-runtime";
import {
  ApiRunListPresenter,
  ApiRunListSearchParams,
} from "~/presenters/v3/ApiRunListPresenter.server";
import { logger } from "~/services/logger.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    searchParams: ApiRunListSearchParams,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (_, __, searchParams) => ({ tasks: searchParams["filter[taskIdentifier]"] }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
    findResource: async () => 1, // This is a dummy function, we don't need to find a resource
  },
  async ({ searchParams, authentication, apiVersion }) => {
    const presenter = new ApiRunListPresenter();
    const result = await presenter.call(
      authentication.environment.project,
      searchParams,
      apiVersion,
      authentication.environment
    );

    return json(result);
  }
);
