import { json } from "@remix-run/server-runtime";
import {
  CreateWaitpointTokenRequestBody,
  type CreateWaitpointTokenResponseBody,
} from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { createWaitpointTag, MAX_TAGS_PER_WAITPOINT } from "~/models/waitpointTag.server";
import {
  ApiWaitpointListPresenter,
  ApiWaitpointListSearchParams,
} from "~/presenters/v3/ApiWaitpointListPresenter.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { parseDelay } from "~/utils/delays";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { engine } from "~/v3/runEngine.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

export const loader = createLoaderApiRoute(
  {
    searchParams: ApiWaitpointListSearchParams,
    findResource: async () => 1, // This is a dummy function, we don't need to find a resource
  },
  async ({ searchParams, authentication }) => {
    const presenter = new ApiWaitpointListPresenter();
    const result = await presenter.call(authentication.environment, searchParams);

    return json(result);
  }
);

const { action } = createActionApiRoute(
  {
    body: CreateWaitpointTokenRequestBody,
    maxContentLength: 1024 * 10, // 10KB
    method: "POST",
  },
  async ({ authentication, body }) => {
    try {
      const idempotencyKeyExpiresAt = body.idempotencyKeyTTL
        ? resolveIdempotencyKeyTTL(body.idempotencyKeyTTL)
        : undefined;

      const timeout = await parseDelay(body.timeout);

      //upsert tags
      let tags: { id: string; name: string }[] = [];
      const bodyTags = typeof body.tags === "string" ? [body.tags] : body.tags;

      if (bodyTags && bodyTags.length > MAX_TAGS_PER_WAITPOINT) {
        throw new ServiceValidationError(
          `Waitpoints can only have ${MAX_TAGS_PER_WAITPOINT} tags, you're trying to set ${bodyTags.length}.`
        );
      }

      if (bodyTags && bodyTags.length > 0) {
        for (const tag of bodyTags) {
          const tagRecord = await createWaitpointTag({
            tag,
            environmentId: authentication.environment.id,
            projectId: authentication.environment.projectId,
          });
          if (tagRecord) {
            tags.push(tagRecord);
          }
        }
      }

      const result = await engine.createManualWaitpoint({
        environmentId: authentication.environment.id,
        projectId: authentication.environment.projectId,
        idempotencyKey: body.idempotencyKey,
        idempotencyKeyExpiresAt,
        timeout,
        tags: bodyTags,
      });

      const $responseHeaders = await responseHeaders(authentication.environment);

      return json<CreateWaitpointTokenResponseBody>(
        {
          id: WaitpointId.toFriendlyId(result.waitpoint.id),
          isCached: result.isCached,
          url: generateHttpCallbackUrl(result.waitpoint.id, authentication.environment.apiKey),
        },
        { status: 200, headers: $responseHeaders }
      );
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: 422 });
      } else if (error instanceof Error) {
        return json({ error: error.message }, { status: 500 });
      }

      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

async function responseHeaders(
  environment: AuthenticatedEnvironment
): Promise<Record<string, string>> {
  const claimsHeader = JSON.stringify({
    sub: environment.id,
    pub: true,
  });

  return {
    "x-trigger-jwt-claims": claimsHeader,
  };
}

export { action };
