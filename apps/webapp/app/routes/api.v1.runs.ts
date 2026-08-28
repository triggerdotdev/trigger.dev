import { json } from "@remix-run/server-runtime";
import {
  ApiRunListPresenter,
  ApiRunListSearchParams,
} from "~/presenters/v3/ApiRunListPresenter.server";
import {
  anyResource,
  createLoaderApiRoute,
  everyResource,
} from "~/services/routeBuilders/apiBuilder.server";
import { RunsListQueryError } from "~/services/runsRepository/runsRepository.server";

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
        // resources we list. Keep type-level runs/tasks as alternatives so
        // broad scopes retain that behavior. ID-scoped keys, however, must
        // match every task in a multi-task filter; matching one item must not
        // expose the others.
        if (taskFilter.length === 0) {
          return anyResource([{ type: "runs" }, { type: "tasks" }]);
        }

        return everyResource(
          taskFilter.map((id) => ({ type: "tasks", id })),
          [{ type: "runs" }, { type: "tasks" }]
        );
      },
    },
    findResource: async () => 1, // This is a dummy function, we don't need to find a resource
  },
  async ({ searchParams, authentication, apiVersion }) => {
    const presenter = new ApiRunListPresenter();
    try {
      const result = await presenter.call(
        authentication.environment.project,
        searchParams,
        apiVersion,
        authentication.environment
      );

      return json(result);
    } catch (error) {
      if (error instanceof RunsListQueryError) {
        return json(
          { error: error.message },
          { status: error.status, headers: { "x-should-retry": "false" } }
        );
      }
      throw error;
    }
  }
);
