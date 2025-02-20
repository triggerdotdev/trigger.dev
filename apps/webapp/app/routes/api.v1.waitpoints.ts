import { json } from "@remix-run/server-runtime";
import { CreateWaitpointRequestBody, CreateWaitpointResponseBody } from "@trigger.dev/core/v3";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { parseDelay } from "~/utils/delays";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { engine } from "~/v3/runEngine.server";

const { action } = createActionApiRoute(
  {
    body: CreateWaitpointRequestBody,
    maxContentLength: 1024 * 10, // 10KB
    method: "POST",
  },
  async ({ authentication, body }) => {
    const idempotencyKeyExpiresAt = body.idempotencyKeyTTL
      ? resolveIdempotencyKeyTTL(body.idempotencyKeyTTL)
      : undefined;

    const timeout = await parseDelay(body.timeout);

    const waitpoint = await engine.createManualWaitpoint({
      environmentId: authentication.environment.id,
      projectId: authentication.environment.projectId,
      idempotencyKey: body.idempotencyKey,
      idempotencyKeyExpiresAt,
      timeout,
    });

    return json<CreateWaitpointResponseBody>(
      {
        id: waitpoint.friendlyId,
      },
      { status: 200 }
    );
  }
);

export { action };
