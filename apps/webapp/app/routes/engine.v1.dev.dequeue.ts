import { json } from "@remix-run/server-runtime";
import { DevDequeueRequestBody } from "@trigger.dev/core/v3";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { engine } from "~/v3/runEngine.server";

const { action } = createActionApiRoute(
  {
    body: DevDequeueRequestBody, // Even though we don't use it, we need to keep it for backwards compatibility
    maxContentLength: 1024 * 10, // 10KB
    method: "POST",
  },
  async ({ authentication }) => {
    const dequeuedMessages = await engine.dequeueFromEnvironmentWorkerQueue({
      consumerId: authentication.environment.id,
      environmentId: authentication.environment.id,
    });

    return json({ dequeuedMessages }, { status: 200 });
  }
);

export { action };
