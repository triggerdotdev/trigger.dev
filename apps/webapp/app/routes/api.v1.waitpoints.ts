import { json } from "@remix-run/server-runtime";
import { CreateWaitpointRequestBody, CreateWaitpointResponseBody } from "@trigger.dev/core/v3";
import { ResumeTokenId, WaitpointId } from "@trigger.dev/core/v3/apps";
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

    const result = await engine.createManualWaitpoint({
      environmentId: authentication.environment.id,
      projectId: authentication.environment.projectId,
      idempotencyKey: body.idempotencyKey,
      idempotencyKeyExpiresAt,
      timeout,
    });

    //result is a waitpoint but we want to make it look like a resume token
    const resumeTokenFriendlyId = ResumeTokenId.toFriendlyId(result.waitpoint.id);

    return json<CreateWaitpointResponseBody>(
      {
        id: resumeTokenFriendlyId,
        isCached: result.isCached,
      },
      { status: 200 }
    );
  }
);

export { action };
