import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
import {
  anyResource,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import { getEventRepositoryForStore } from "~/v3/eventRepository/index.server";

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
      resource: (run) => {
        const resources = [
          { type: "runs", id: run.friendlyId },
          { type: "tasks", id: run.taskIdentifier },
          ...run.runTags.map((tag) => ({ type: "tags", id: tag })),
        ];
        if (run.batch?.friendlyId) {
          resources.push({ type: "batch", id: run.batch.friendlyId });
        }
        return anyResource(resources);
      },
    },
  },
  async ({ resource: run, authentication }) => {
    // Short-circuit for mollifier-buffered runs. The drainer hasn't
    // materialised execution events yet (the gate intercepts before
    // any trace event is written), so a ClickHouse round-trip is
    // guaranteed to come back empty. `findRun` now sets `isBuffered`
    // explicitly on its return value — gate on that rather than
    // probing surrogate fields like `traceId === ""`.
    if (run.isBuffered) {
      return json({ events: [] }, { status: 200 });
    }

    const eventRepository = await getEventRepositoryForStore(
      run.taskEventStore,
      authentication.environment.organization.id
    );

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
