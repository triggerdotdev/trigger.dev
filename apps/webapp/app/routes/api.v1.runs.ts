import { json } from "@remix-run/server-runtime";
import {
  ApiRunListPresenter,
  ApiRunListSearchParams,
} from "~/presenters/v3/ApiRunListPresenter.server";
import { logger } from "~/services/logger.server";
import {
  anyResource,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    searchParams: ApiRunListSearchParams,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (_, __, searchParams) => {
        const taskFilter = searchParams["filter[taskIdentifier]"] ?? [];
        return anyResource([
          { type: "runs" },
          ...taskFilter.map((id) => ({ type: "tasks", id })),
        ]);
      },
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
