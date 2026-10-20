import {
  isInfrastructureError,
  WebhookEngine,
  WebhookInfrastructureError,
} from "@internal/webhook-engine";
import type { WebhookDeliverTaskErrorType, WebhookRedisOptions } from "@internal/webhook-engine";
import { tryCatch } from "@trigger.dev/core/utils";
import { resolve4 } from "node:dns/promises";
import { z } from "zod";
import { prisma, webhookPartitionPrisma, webhookPrisma } from "~/db.server";
import { env } from "~/env.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { ensureRunForSession } from "~/services/realtime/sessionRunManager.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { drainSessionStreamWaitpoints } from "~/services/sessionStreamWaitpointCache.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { singleton } from "~/utils/singleton";
import { engine as runEngine } from "./runEngine.server";
import { ServiceValidationError } from "./services/common.server";
import { TriggerTaskService } from "./services/triggerTask.server";
import { resolveWebhookSession } from "./webhookSessionTarget.server";
import { activeSigningSecrets, StoredSigningSecret } from "./webhookSigningSecret";
import { webhookLimitsForEnvironment } from "./webhookLimits.server";
import { webhookPortErrorMessage } from "./webhookPortErrors.server";
import { webhookWaitpoints } from "./webhookWaitpoints.server";
import { meter, tracer } from "./tracer.server";

export const webhookEngine = singleton("WebhookEngine", createWebhookEngine);

/**
 * Resolves the seed host to one of its addresses at random on every connect and reconnect. After a
 * failover, ElastiCache's configuration endpoint keeps listing the old primary for minutes, and the
 * system resolver always ranks the address in the client's own subnet first, so a cluster client
 * that has to reconnect through the seed can keep landing on the dead node. TLS still verifies the
 * seed host (`servername`). A name that doesn't resolve, such as an IP or localhost, is used as is.
 */
function randomSeedAddress(
  address: string,
  callback: (err: Error | null, address: string) => void
) {
  resolve4(address).then(
    (addresses) =>
      callback(null, addresses[Math.floor(Math.random() * addresses.length)] ?? address),
    () => callback(null, address)
  );
}

/**
 * The webhooks Redis cluster, seeded from one node; ioredis discovers the rest. A primary that stops
 * answering without closing its sockets (an ElastiCache failover reboots the old one) never replies
 * MOVED, so the slot map is refreshed on an interval to find the promoted replica, and a command
 * waiting on the silent node times out instead of holding an ingest request. Redirects can name a
 * node by IP, which AWS certificates don't cover, so TLS checks every node against the seed host.
 */
function webhookRedisConnection(): WebhookRedisOptions {
  const host = env.WEBHOOK_REDIS_HOST ?? "localhost";
  const redisOptions = {
    username: env.WEBHOOK_REDIS_USERNAME,
    password: env.WEBHOOK_REDIS_PASSWORD,
    enableAutoPipelining: true,
    commandTimeout: 3_000,
    connectTimeout: 3_000,
    ...(env.WEBHOOK_REDIS_TLS_DISABLED === "true" ? {} : { tls: { servername: host } }),
  };
  return {
    cluster: {
      nodes: [{ host, port: env.WEBHOOK_REDIS_PORT ?? 6379 }],
      redisOptions,
      clusterOptions: {
        keyPrefix: "webhook:",
        dnsLookup: randomSeedAddress,
        slotsRefreshInterval: 2_000,
        slotsRefreshTimeout: 2_000,
      },
    },
  };
}

/** The GET verification token (Meta hub.verify_token) an endpoint owner generated in the dashboard. */
const VerifyTokenSchema = z.object({ token: z.string() });

/** SecretStore key of an endpoint's verify token; shared with the endpoint detail route. */
export function webhookVerifyTokenKey(endpointId: string): string {
  return `webhook:verify-token:${endpointId}`;
}

function createWebhookEngine() {
  // The engine owns the webhook tables, so it runs on the webhook DB client. The signing-secret
  // store stays on the main client below (SecretStore is control-plane, not part of the split).
  const secretStore = getSecretStore("DATABASE", { prismaClient: prisma });

  const engine = new WebhookEngine({
    prisma: webhookPrisma,
    partitionPrisma: webhookPartitionPrisma,
    logLevel: env.WEBHOOK_ENGINE_LOG_LEVEL,
    disabled: env.WEBHOOK_ENABLED !== "1",
    redis: webhookRedisConnection(),
    worker: {
      concurrency: env.WEBHOOK_WORKER_CONCURRENCY_LIMIT,
      tenantConcurrency: async (environmentId) =>
        (await webhookLimitsForEnvironment(environmentId)).concurrency,
      pollIntervalMs: env.WEBHOOK_WORKER_POLL_INTERVAL,
      disabled: env.WEBHOOK_ENABLED !== "1" || env.WEBHOOK_WORKER_ENABLED !== "true",
    },
    partitions: {
      lookaheadDays: env.WEBHOOK_PARTITION_LOOKAHEAD_DAYS,
    },
    queue: {
      environmentPayloadBytesLimit: async (environmentId) =>
        (await webhookLimitsForEnvironment(environmentId)).queuedPayloadBytes,
      highWater: env.WEBHOOK_QUEUE_HIGH_WATER,
    },
    retention: {
      forEnvironment: async (environmentId) =>
        (await webhookLimitsForEnvironment(environmentId)).deliveryStorageDays,
      defaultDays: env.WEBHOOK_DELIVERY_STORAGE_DAYS,
    },
    frontGate: {
      defaultTtlSeconds: env.WEBHOOK_FRONT_GATE_DEFAULT_TTL_SECONDS,
      maxTtlSeconds: env.WEBHOOK_FRONT_GATE_MAX_TTL_SECONDS,
    },
    endpointCache: {
      ttlMs: env.WEBHOOK_ENDPOINT_CACHE_TTL_MS,
      maxSize: env.WEBHOOK_ENDPOINT_CACHE_MAX_SIZE,
    },
    waiters: {
      limits: {
        perEnvironment: env.WEBHOOK_WAITER_MAX_PER_ENVIRONMENT,
        perEndpoint: env.WEBHOOK_WAITER_MAX_PER_ENDPOINT,
        shapes: env.WEBHOOK_WAITER_MAX_SHAPES,
      },
      completionChunkSize: env.WEBHOOK_WAITER_COMPLETION_CHUNK_SIZE,
      urlSecret: env.ENCRYPTION_KEY,
      waitpoints: webhookWaitpoints,
    },
    tracer,
    meter,
    resolveSigningSecret: async (key) => {
      const value = await secretStore.getSecret(StoredSigningSecret, key);
      // Fail closed: an unset/empty secret returns undefined so ingest rejects.
      const secrets = activeSigningSecrets(value, new Date());
      return secrets.length > 0 ? secrets : undefined;
    },
    resolveVerifyToken: async (endpointId) => {
      const value = await secretStore.getSecret(
        VerifyTokenSchema,
        webhookVerifyTokenKey(endpointId)
      );
      return value?.token || undefined;
    },
    triggerTask: async ({
      environmentId,
      taskId,
      deliveryId,
      idempotencyKey,
      idempotencyKeyExpiresAt,
      payload,
      headers,
      identityTags,
      endpointMetadata,
      endpoint,
    }) => {
      try {
        const environment = await findEnvironmentById(environmentId);
        if (!environment) {
          return { success: false, errorType: "NOT_FOUND", error: "Environment not found" };
        }

        const triggerService = new TriggerTaskService();

        const result = await triggerService.call(
          taskId,
          environment,
          {
            payload: { event: payload, headers, endpoint },
            options: {
              tags: identityTags,
              metadata: (endpointMetadata as Record<string, unknown>) ?? undefined,
            },
          },
          {
            idempotencyKey,
            idempotencyKeyExpiresAt,
            triggerSource: "webhook",
            triggerAction: "trigger",
            customIcon: "webhook",
            webhookDeliveryId: deliveryId,
            webhookEndpointId: endpoint.id,
          }
        );

        return { success: !!result, runId: result?.run.id };
      } catch (error) {
        return {
          success: false,
          error: webhookPortErrorMessage(error, "triggerTask"),
          errorType: portErrorType(error),
        };
      }
    },
    deliverToSession: async ({
      environmentId,
      taskIdentifier,
      externalId,
      deliverAs,
      actionType,
      connectorId,
      event,
      source,
      headers,
      deliveryId,
      externalDeliveryId,
      partId,
      endpoint,
      triggerConfigTemplate,
      isSessionStart,
      claimPart,
      commitPart,
      releasePart,
    }) => {
      try {
        const environment = await findEnvironmentById(environmentId);
        if (!environment) {
          return { success: false, errorType: "NOT_FOUND", error: "Environment not found" };
        }

        const resolution = await resolveWebhookSession({
          environment,
          externalId,
          taskIdentifier,
          isSessionStart,
          triggerConfigTemplate,
        });
        if (resolution.kind === "skipped") {
          return { success: true, skipped: true, skippedReason: resolution.reason };
        }
        if (resolution.kind === "rejected") {
          return { success: false, error: resolution.error };
        }
        const { session, isCached } = resolution;

        // Boot / revive the run, then append the action. The run reads it from `.in`.
        const ensureResult = await ensureRunForSession({
          session,
          environment,
          reason: isCached ? "continuation" : "initial",
        });

        const realtimeStream = getRealtimeStreamInstance(environment, "v2", { session });
        if (!(realtimeStream instanceof S2RealtimeStreams)) {
          return { success: false, error: "Session channels require the S2 realtime backend" };
        }

        const addressingKey = session.externalId ?? session.friendlyId;
        // "action" (chat.event) -> onAction envelope; "message" (channels) -> a turn whose message the
        // run derives by applying the connector's inbound() to the raw event.
        const payload =
          deliverAs === "message"
            ? {
                chatId: externalId,
                trigger: "submit-message",
                channelEvent: {
                  connectorId,
                  event,
                  source,
                  headers,
                  deliveryId,
                  externalDeliveryId,
                  endpoint,
                },
              }
            : {
                chatId: externalId,
                trigger: "action",
                actionSource: "webhook",
                action: {
                  type: actionType,
                  event,
                  source,
                  headers,
                  deliveryId,
                  externalDeliveryId,
                  endpoint,
                },
              };
        const part = JSON.stringify({ kind: "message", payload });

        const claim = await claimPart();
        if (claim === "busy") {
          throw new WebhookInfrastructureError(
            "Another attempt is appending this delivery to the session"
          );
        }
        if (claim === "append") {
          const [appendError] = await tryCatch(
            realtimeStream.appendPartToSessionStream(part, partId, addressingKey, "in")
          );
          if (appendError) {
            // Nothing landed — release the claim so a retry re-appends the same id.
            await releasePart();
            // A ServiceValidationError (e.g. record too large) is terminal; anything else is transient.
            if (appendError instanceof ServiceValidationError) {
              return { success: false, error: appendError.message };
            }
            throw appendError;
          }
          await commitPart();
        }

        // Wake any `.in` waitpoints the run registered (best-effort; the record is durable in S2).
        const [drainError, waitpointIds] = await tryCatch(
          drainSessionStreamWaitpoints(environment.id, addressingKey, "in")
        );
        if (drainError) {
          logger.error("deliverToSession: failed to drain session waitpoints", {
            externalId,
            error: drainError,
          });
        } else if (waitpointIds && waitpointIds.length > 0) {
          await Promise.all(
            waitpointIds.map((waitpointId) =>
              tryCatch(
                runEngine.completeWaitpoint({
                  id: waitpointId,
                  output: { value: part, type: "application/json", isError: false },
                })
              )
            )
          );
        }

        return { success: true, runId: ensureResult.runId };
      } catch (error) {
        return {
          success: false,
          error: webhookPortErrorMessage(error, "deliverToSession"),
          errorType: portErrorType(error),
        };
      }
    },
  });

  return engine;
}

/** How a port failure retries: forever for our infrastructure, a few times for anything else. */
function portErrorType(error: unknown): WebhookDeliverTaskErrorType {
  if (
    error instanceof ServiceValidationError &&
    error.message.includes("queue size limit for this environment has been reached")
  ) {
    return "QUEUE_LIMIT";
  }
  if (isInfrastructureError(error)) return "INFRASTRUCTURE";
  return "SYSTEM_ERROR";
}
