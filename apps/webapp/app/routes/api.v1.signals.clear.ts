import { z } from "zod";
import { clearEnvironmentSignal } from "~/services/realtime/environmentSignals.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { signalApiResponse } from "~/services/signalApi.server";

const Body = z.object({
  name: z.string(),
  task: z.string().optional(),
});

// Free a signal name: the latest signal of (name, task) is removed, so runs that start listening
// later don't get it and it stops counting towards the environment's cap. Runs already listening
// aren't told. Secret key, a run's own token, or a key with `write:signals`. Unstable.
const { action } = createActionApiRoute(
  {
    body: Body,
    method: "POST",
    authorization: { action: "write", resource: () => ({ type: "signals" }) },
  },
  async ({ body, authentication }) =>
    signalApiResponse(authentication, "Clearing a signal", body, (environment) =>
      clearEnvironmentSignal(environment, { name: body.name, task: body.task })
    )
);

export { action };
