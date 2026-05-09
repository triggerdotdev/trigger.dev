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
        // Pre-RBAC, the resource was `{ tasks: searchParams["filter[taskIdentifier]"] }`
        // and the legacy `checkAuthorization` iterated `Object.keys` — so a
        // JWT with type-level `read:tasks` (no id) granted access to the
        // unfiltered runs list. The new ability model only matches against
        // resources we list, so the type-level `{ type: "tasks" }` element
        // (alongside `{ type: "runs" }` and the per-id task elements)
        // preserves that semantic — `read:tasks` JWTs in the wild still
        // list unfiltered runs without needing a separate `read:runs`
        // scope. Per-id `read:tasks:foo` still grants only when the
        // filter includes `foo`.
        return anyResource([
          { type: "runs" },
          { type: "tasks" },
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
