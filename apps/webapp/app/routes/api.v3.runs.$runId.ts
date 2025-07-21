import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: (params, auth) => {
      return ApiRetrieveRunPresenter.findRun(params.runId, auth.environment);
    },
    shouldRetryNotFound: true,
    authorization: {
      action: "read",
      resource: (run) => ({
        runs: run.friendlyId,
        tags: run.runTags,
        batch: run.batch?.friendlyId,
        tasks: run.taskIdentifier,
      }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ authentication, resource, apiVersion }) => {
    const presenter = new ApiRetrieveRunPresenter(apiVersion);
    const result = await presenter.call(resource, authentication.environment);

    if (!result) {
      return json(
        { error: "Run not found" },
        { status: 404, headers: { "x-should-retry": "true" } }
      );
    }

    return json(result);
  }
);
