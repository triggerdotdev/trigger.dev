import { json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { devPresence } from "~/presenters/v3/DevPresence.server";
import { authenticateApiRequestWithFailure } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { createSSELoader } from "~/utils/sse";

export const loader = createSSELoader({
  timeout: env.DEV_PRESENCE_SSE_TIMEOUT,
  interval: env.DEV_PRESENCE_TTL_MS * 0.8,
  debug: false,
  handler: async ({ id, controller, debug, request }) => {
    const authentication = await authenticateApiRequestWithFailure(request);

    if (!authentication.ok) {
      throw json({ error: "Invalid or Missing API key" }, { status: 401 });
    }

    const environmentId = authentication.environment.id;
    const projectId = authentication.environment.projectId;
    const userId = authentication.environment.orgMember?.userId;

    if (!userId) {
      throw json({ error: "Not a dev environment" }, { status: 400 });
    }

    const ttl = env.DEV_PRESENCE_TTL_MS / 1000;

    return {
      beforeStream: async () => {
        logger.debug("Start dev presence SSE session", {
          environmentId,
        });
      },
      initStream: async ({ send }) => {
        // Set initial presence with more context
        await devPresence.setConnected({ userId, projectId, environmentId, ttl });
        send({ event: "start", data: `Started ${id}` });
      },
      iterator: async ({ send, date }) => {
        await devPresence.setConnected({ userId, projectId, environmentId, ttl });
        send({ event: "time", data: new Date().toISOString() });
      },
      cleanup: async () => {},
    };
  },
});
