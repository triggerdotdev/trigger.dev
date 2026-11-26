import { z } from "zod";
import { sendEnvironmentSignal } from "~/services/realtime/environmentSignals.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { signalApiResponse } from "~/services/signalApi.server";

const Body = z.object({
  name: z.string(),
  payload: z.unknown().optional(),
  task: z.string().optional(),
});

// Send a signal to the environment's executing runs. Secret key, a run's own token, or a key with
// `write:signals`: public keys and public JWTs can't send. Unstable.
const { action } = createActionApiRoute(
  {
    body: Body,
    method: "POST",
    authorization: { action: "write", resource: () => ({ type: "signals" }) },
  },
  async ({ body, authentication }) =>
    signalApiResponse(authentication, "Sending a signal", body, async (environment) => {
      const { seq } = await sendEnvironmentSignal(environment, {
        name: body.name,
        payload: body.payload ?? null,
        task: body.task,
      });
      return { seq };
    })
);

export { action };
