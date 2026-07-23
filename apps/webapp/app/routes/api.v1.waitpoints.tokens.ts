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
import {
  runOpsNewReplicaClient,
  runOpsLegacyReplica,
  runOpsSplitReadEnabled,
  type PrismaClientOrTransaction,
} from "~/db.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { resolveRunIdMintKind } from "~/v3/engineVersion.server";
import { logger } from "~/services/logger.server";
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
    const presenter = new ApiWaitpointListPresenter(undefined, undefined, {
      runOpsNew: runOpsNewReplicaClient as unknown as PrismaClientOrTransaction,
      runOpsLegacyReplica: runOpsLegacyReplica as unknown as PrismaClientOrTransaction,
      splitEnabled: runOpsSplitReadEnabled,
    });
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

      // A token (and its tags) has no owning run, so it can't co-locate. Resolve the env mint kind so a
      // minted-new env creates them on the run-ops DB (NEW) instead of defaulting to the draining LEGACY
      // DB by their cuid id-shape.
      const mintKind = await resolveRunIdMintKind({
        organizationId: authentication.environment.organizationId,
        id: authentication.environment.id,
        orgFeatureFlags: authentication.environment.organization.featureFlags,
      });
      const residency = mintKind === "runOpsId" ? "NEW" : "LEGACY";

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
            residency,
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
        standaloneResidency: residency,
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
      }

      logger.error("Failed to create waitpoint token", { error });
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
