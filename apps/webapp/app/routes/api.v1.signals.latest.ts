import { z } from "zod";
import { latestEnvironmentSignal } from "~/services/realtime/environmentSignals.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { signalApiResponse } from "~/services/signalApi.server";

const SearchParams = z.object({
  name: z.string(),
  task: z.string().optional(),
  includeUntasked: z.enum(["true", "false"]).optional(),
});

// The latest signal of a name (sent with `task`, if given) without subscribing: `{ signal }`, null
// when there is none. With `includeUntasked=true` and a task, the newer of that and the untasked
// one, which is what a run of that task receives first from `on(name)`. Secret key, a run's own
// token, or a key with `read:signals`. Unstable.
export const loader = createLoaderApiRoute(
  {
    searchParams: SearchParams,
    // The resource is the environment itself, which authentication already resolved.
    findResource: async () => true,
    authorization: { action: "read", resource: () => ({ type: "signals" }) },
  },
  async ({ searchParams, authentication }) =>
    signalApiResponse(
      authentication,
      "Reading a signal",
      { name: searchParams.name, task: searchParams.task },
      async (environment) => ({
        signal: await latestEnvironmentSignal(environment, {
          name: searchParams.name,
          task: searchParams.task,
          includeUntasked: searchParams.includeUntasked === "true",
        }),
      }),
      { read: true }
    )
);
