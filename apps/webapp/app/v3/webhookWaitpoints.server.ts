import type { WebhookWaitpointPorts } from "@internal/webhook-engine";
import { stringifyIO } from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { tryCatch } from "@trigger.dev/core/utils";
import pLimit from "p-limit";
import { env } from "~/env.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { createWaitpointTag } from "~/models/waitpointTag.server";
import { processWaitpointCompletionPacket } from "~/runEngine/concerns/waitpointCompletionPacket.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { resolveRunIdMintKind } from "~/v3/engineVersion.server";
import { engine } from "~/v3/runEngine.server";
import { resolveMintShard } from "~/v3/runOpsMigration/runOpsMintShard.server";
import { runStore } from "~/v3/runStore.server";

const completionLimit = pLimit(env.WEBHOOK_WAITER_COMPLETION_CONCURRENCY);

async function environmentOrThrow(environmentId: string): Promise<AuthenticatedEnvironment> {
  const environment = await findEnvironmentById(environmentId);
  if (!environment) throw new Error(`Environment ${environmentId} not found`);
  return environment;
}

/**
 * Where a standalone MANUAL waitpoint lives, resolved exactly as the waitpoint token route does: a
 * waiter has no owning run, so it follows the environment's mint kind (and shard for gen-2 ids).
 */
async function standalonePlacement(environment: AuthenticatedEnvironment) {
  const mintKind = await resolveRunIdMintKind({
    organizationId: environment.organizationId,
    id: environment.id,
    orgFeatureFlags: environment.organization.featureFlags,
  });
  const residency = mintKind === "runOpsId" ? ("NEW" as const) : ("LEGACY" as const);
  const shardKey =
    mintKind === "runOpsId"
      ? await resolveMintShard({
          id: environment.id,
          orgFeatureFlags: environment.organization.featureFlags,
        })
      : undefined;
  const isGen2 = shardKey !== undefined && shardKey !== "new" && shardKey !== "legacy";
  return { residency, shardKey, colocate: isGen2 ? undefined : { residency } };
}

/**
 * The MANUAL waitpoints behind webhook waiters. A waiter's id is its waitpoint's friendly id, so it
 * shows on the run timeline and the waitpoints page. Completion builds the output packet once per
 * call (one stringify, at most one object-store upload) and completes the waiters with it. One limit
 * covers every call in the process, so concurrent chunk jobs can't flood the database pool.
 */
export const webhookWaitpoints: WebhookWaitpointPorts = {
  async find({ environmentId, idempotencyKey }) {
    const environment = await environmentOrThrow(environmentId);
    const { colocate } = await standalonePlacement(environment);
    const waitpoint = await runStore.findWaitpoint(
      { where: { environmentId, idempotencyKey } },
      undefined,
      colocate
    );
    if (!waitpoint) return undefined;
    if (waitpoint.idempotencyKeyExpiresAt && waitpoint.idempotencyKeyExpiresAt < new Date()) {
      return undefined;
    }
    return {
      id: WaitpointId.toFriendlyId(waitpoint.id),
      status: waitpoint.status === "COMPLETED" ? "COMPLETED" : "PENDING",
      timeoutAt: waitpoint.completedAfter ?? undefined,
      tags: waitpoint.tags,
    };
  },

  async create({
    environmentId,
    projectId,
    idempotencyKey,
    idempotencyKeyExpiresAt,
    timeoutAt,
    tags,
  }) {
    const environment = await environmentOrThrow(environmentId);
    const { residency, shardKey } = await standalonePlacement(environment);

    for (const tag of tags) {
      await createWaitpointTag({ tag, environmentId, projectId, residency, shardKey });
    }

    const result = await engine.createManualWaitpoint({
      environmentId,
      projectId,
      idempotencyKey,
      idempotencyKeyExpiresAt,
      timeout: timeoutAt,
      tags,
      standaloneResidency: residency,
      standaloneShardKey: shardKey,
    });
    return { id: WaitpointId.toFriendlyId(result.waitpoint.id), isCached: result.isCached };
  },

  async complete({ environmentId, waitpointIds, output, deliveryFriendlyId }) {
    const environment = await environmentOrThrow(environmentId);
    const packet = await processWaitpointCompletionPacket(
      await stringifyIO(output),
      environment,
      `${deliveryFriendlyId}/webhook-waiters`
    );

    return Promise.all(
      waitpointIds.map((id) =>
        completionLimit(async () => {
          const [error] = await tryCatch(
            engine.completeWaitpoint({
              id: WaitpointId.toId(id),
              output: packet.data
                ? { type: packet.dataType, value: packet.data, isError: false }
                : undefined,
            })
          );
          return error
            ? { id, ok: false, error: error instanceof Error ? error.message : String(error) }
            : { id, ok: true };
        })
      )
    );
  },

  async fail({ waitpointId, error }) {
    await engine.completeWaitpoint({
      id: WaitpointId.toId(waitpointId),
      output: { value: JSON.stringify(error), isError: true },
    });
  },
};
