import { isInfrastructureError, type WebhookWaitpointPorts } from "@internal/webhook-engine";
import { MAX_INLINE_COMPLETION_OUTPUT_BYTES } from "@internal/run-engine";
import { webhookPortErrorMessage } from "./webhookPortErrors.server";
import { stringifyIO } from "@trigger.dev/core/v3";
import { parseWaitpointId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
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
    const { colocate, residency, shardKey } = await standalonePlacement(environment);
    let waitpoint = await runStore.findWaitpoint(
      { where: { environmentId, idempotencyKey } },
      undefined,
      colocate
    );
    if (
      !waitpoint ||
      (waitpoint.idempotencyKeyExpiresAt && waitpoint.idempotencyKeyExpiresAt < new Date())
    ) {
      if (!(await engine.waitpointSystem.isWaitpointStoreEnabled(environment.organizationId)))
        return undefined;
      waitpoint = await engine.readExistingStoreDateTimeWaitpointByKey({
        environmentId,
        projectId: environment.projectId,
        organizationId: environment.organizationId,
        idempotencyKey,
        standaloneResidency: residency,
        standaloneShardKey: shardKey,
      });
    }
    if (!waitpoint) return undefined;
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
      organizationId: environment.organizationId,
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
    const storeEnabled = await engine.waitpointSystem.isWaitpointStoreEnabled(
      environment.organizationId
    );
    const hasNativeDateTime =
      storeEnabled &&
      waitpointIds.some((id) => {
        const parsed = parseWaitpointId(WaitpointId.toId(id));
        return (
          parsed.format !== "legacy" && (parsed.type === "DATETIME" || parsed.type === "MANUAL")
        );
      });
    const pathPrefix = `${deliveryFriendlyId}/webhook-waiters`;
    const packet = await processWaitpointCompletionPacket(
      await stringifyIO(output),
      environment,
      // One object per call, so competing deliveries cannot replace accepted native output.
      hasNativeDateTime ? `${pathPrefix}/${crypto.randomUUID()}` : pathPrefix,
      hasNativeDateTime ? MAX_INLINE_COMPLETION_OUTPUT_BYTES : undefined
    );

    return Promise.all(
      waitpointIds.map((id) =>
        completionLimit(async () => {
          const waitpointId = WaitpointId.toId(id);
          const parsed = storeEnabled ? parseWaitpointId(waitpointId) : undefined;
          const completionInput: Parameters<typeof engine.completeWaitpoint>[0] = {
            id: waitpointId,
            ...(storeEnabled ? { organizationId: environment.organizationId } : {}),
            output: packet.data
              ? { type: packet.dataType, value: packet.data, isError: false }
              : undefined,
          };
          if (
            parsed &&
            parsed.format !== "legacy" &&
            (parsed.type === "DATETIME" || parsed.type === "MANUAL")
          )
            completionInput.onlyIfPending = true;
          const [error] = await tryCatch(engine.completeWaitpoint(completionInput));
          return error
            ? {
                id,
                ok: false,
                error: webhookPortErrorMessage(error, "completeWaitpoint"),
                infrastructure: isInfrastructureError(error),
              }
            : { id, ok: true };
        })
      )
    );
  },

  async fail({ environmentId, organizationId, waitpointId, error }) {
    const id = WaitpointId.toId(waitpointId);
    const storeEnabled = await engine.waitpointSystem.isWaitpointStoreEnabled(organizationId);
    const parsed = storeEnabled ? parseWaitpointId(id) : undefined;
    if (
      parsed &&
      parsed.format !== "legacy" &&
      (parsed.type === "DATETIME" || parsed.type === "MANUAL")
    ) {
      const environment = await environmentOrThrow(environmentId);
      const waitpoint = await engine.getStoreDateTimeWaitpoint({
        waitpointId: id,
        environmentId,
        projectId: environment.projectId,
        organizationId: environment.organizationId,
      });
      if (!waitpoint) throw new Error("Waitpoint not found");
      await engine.completeWaitpoint({
        id,
        organizationId: environment.organizationId,
        onlyIfPending: true,
        output: { value: JSON.stringify(error), isError: true },
      });
      return;
    }
    await engine.completeWaitpoint({
      id,
      ...(storeEnabled ? { organizationId } : {}),
      output: { value: JSON.stringify(error), isError: true },
    });
  },
};
