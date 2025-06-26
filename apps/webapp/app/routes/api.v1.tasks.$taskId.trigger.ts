import { json } from "@remix-run/server-runtime";
import {
  generateJWT as internal_generateJWT,
  RunEngineVersionSchema,
  TriggerTaskRequestBody,
} from "@trigger.dev/core/v3";
import { TaskRun } from "@trigger.dev/database";
import { z } from "zod";
import { env } from "~/env.server";
import { EngineServiceValidationError } from "~/runEngine/concerns/errors";
import {
  ApiAuthenticationResultSuccess,
  AuthenticatedEnvironment,
  getOneTimeUseToken,
} from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { OutOfEntitlementError, TriggerTaskService } from "~/v3/services/triggerTask.server";

const ParamsSchema = z.object({
  taskId: z.string(),
});

export const HeadersSchema = z.object({
  "idempotency-key": z.string().nullish(),
  "idempotency-key-ttl": z.string().nullish(),
  "trigger-version": z.string().nullish(),
  "x-trigger-span-parent-as-link": z.coerce.number().nullish(),
  "x-trigger-worker": z.string().nullish(),
  "x-trigger-client": z.string().nullish(),
  "x-trigger-engine-version": RunEngineVersionSchema.nullish(),
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
});

const { action, loader } = createActionApiRoute(
  {
    headers: HeadersSchema,
    params: ParamsSchema,
    body: TriggerTaskRequestBody,
    allowJWT: true,
    maxContentLength: env.TASK_PAYLOAD_MAXIMUM_SIZE,
    authorization: {
      action: "trigger",
      resource: (params) => ({ tasks: params.taskId }),
      superScopes: ["write:tasks", "admin"],
    },
    corsStrategy: "all",
  },
  async ({ body, headers, params, authentication }) => {
    const {
      "idempotency-key": idempotencyKey,
      "idempotency-key-ttl": idempotencyKeyTTL,
      "trigger-version": triggerVersion,
      "x-trigger-span-parent-as-link": spanParentAsLink,
      traceparent,
      tracestate,
      "x-trigger-worker": isFromWorker,
      "x-trigger-client": triggerClient,
      "x-trigger-engine-version": engineVersion,
    } = headers;

    const service = new TriggerTaskService();

    try {
      const traceContext =
        traceparent && isFromWorker /// If the request is from a worker, we should pass the trace context
          ? { traceparent, tracestate }
          : undefined;

      const oneTimeUseToken = await getOneTimeUseToken(authentication);

      logger.debug("Triggering task", {
        taskId: params.taskId,
        idempotencyKey,
        idempotencyKeyTTL,
        triggerVersion,
        headers,
        options: body.options,
        isFromWorker,
        traceContext,
      });

      const idempotencyKeyExpiresAt = resolveIdempotencyKeyTTL(idempotencyKeyTTL);

      const result = await service.call(
        params.taskId,
        authentication.environment,
        body,
        {
          idempotencyKey: idempotencyKey ?? undefined,
          idempotencyKeyExpiresAt: idempotencyKeyExpiresAt,
          triggerVersion: triggerVersion ?? undefined,
          traceContext,
          spanParentAsLink: spanParentAsLink === 1,
          oneTimeUseToken,
        },
        engineVersion ?? undefined
      );

      if (!result) {
        return json({ error: "Task not found" }, { status: 404 });
      }

      const $responseHeaders = await responseHeaders(result.run, authentication, triggerClient);

      return json(
        {
          id: result.run.friendlyId,
          isCached: result.isCached,
        },
        {
          headers: $responseHeaders,
        }
      );
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 422 });
      } else if (error instanceof EngineServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 422 });
      } else if (error instanceof OutOfEntitlementError) {
        return json({ error: error.message }, { status: 422 });
      } else if (error instanceof Error) {
        return json({ error: error.message }, { status: 500 });
      }

      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

async function responseHeaders(
  run: TaskRun,
  authentication: ApiAuthenticationResultSuccess,
  triggerClient?: string | null
): Promise<Record<string, string>> {
  const { environment, realtime } = authentication;

  const claimsHeader = JSON.stringify({
    sub: environment.id,
    pub: true,
    realtime,
  });

  if (triggerClient === "browser") {
    const claims = {
      sub: environment.id,
      pub: true,
      scopes: [`read:runs:${run.friendlyId}`],
      realtime,
    };

    const jwt = await internal_generateJWT({
      secretKey: environment.apiKey,
      payload: claims,
      expirationTime: "1h",
    });

    return {
      "x-trigger-jwt-claims": claimsHeader,
      "x-trigger-jwt": jwt,
    };
  }

  return {
    "x-trigger-jwt-claims": claimsHeader,
  };
}

export { action, loader };
