import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import { resolveEventRepositoryForStore } from "~/v3/eventRepository/index.server";

const ParamsSchema = z.object({
  runId: z.string(), // This is the run friendly ID
});

// TODO: paginate the results
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
  async ({ resource: run, authentication }) => {
    const eventRepository = resolveEventRepositoryForStore(run.taskEventStore);

    const runEvents = await eventRepository.getRunEvents(
      getTaskEventStoreTableForRun(run),
      authentication.environment.id,
      run.traceId,
      run.friendlyId,
      run.createdAt,
      run.completedAt ?? undefined
    );

    // TODO: return only relevant fields, avoid returning the whole events
    return json(
      {
        events: runEvents.map((event) => {
          return JSON.parse(
            JSON.stringify(event, (_, value) =>
              // needed as JSON.stringify doesn't know how to handle BigInt values by default
              typeof value === "bigint" ? value.toString() : value
            )
          );
        }),
      },
      { status: 200 }
    );
  }
);
