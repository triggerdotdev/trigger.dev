import { WebhookEngine } from "@internal/webhook-engine";
import type { WebhookDeliverTaskErrorType } from "@internal/webhook-engine";
import { tryCatch } from "@trigger.dev/core/utils";
import { z } from "zod";
import { prisma, webhookPartitionPrisma, webhookPrisma } from "~/db.server";
import { env } from "~/env.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { ensureRunForSession } from "~/services/realtime/sessionRunManager.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import {
  claimSessionStreamPart,
  drainSessionStreamWaitpoints,
  releaseSessionStreamPart,
} from "~/services/sessionStreamWaitpointCache.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { singleton } from "~/utils/singleton";
import { engine as runEngine } from "./runEngine.server";
import { ServiceValidationError } from "./services/common.server";
import { TriggerTaskService } from "./services/triggerTask.server";
import { resolveWebhookSession } from "./webhookSessionTarget.server";
import { webhookLimitsForEnvironment } from "./webhookLimits.server";
import { webhookWaitpoints } from "./webhookWaitpoints.server";
import { meter, tracer } from "./tracer.server";

export const webhookEngine = singleton("WebhookEngine", createWebhookEngine);

function waiterStoreConnection() {
  const redisOptions = {
    host: env.WEBHOOK_WAITER_REDIS_HOST ?? "localhost",
    port: env.WEBHOOK_WAITER_REDIS_PORT ?? 6379,
    username: env.WEBHOOK_WAITER_REDIS_USERNAME,
    password: env.WEBHOOK_WAITER_REDIS_PASSWORD,
    keyPrefix: "webhook:",
    enableAutoPipelining: true,
    ...(env.WEBHOOK_WAITER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };
  if (env.WEBHOOK_WAITER_REDIS_CLUSTER_MODE_ENABLED === "1") {
    return {
      cluster: {
        nodes: [{ host: redisOptions.host, port: redisOptions.port }],
        redisOptions,
        clusterOptions: {
          dnsLookup: (address: string, callback: (err: Error | null, address: string) => void) =>
            callback(null, address),
          slotsRefreshTimeout: 10_000,
        },
      },
    };
  }
  return { redis: redisOptions };
}

// The plaintext signing secret is stored under the "DATABASE" SecretStore
// provider as { secret: string } (same shape as environment variables).
const SigningSecretSchema = z.object({ secret: z.string() });

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
    redis: {
      host: env.WEBHOOK_WORKER_REDIS_HOST ?? "localhost",
      port: env.WEBHOOK_WORKER_REDIS_PORT ?? 6379,
      username: env.WEBHOOK_WORKER_REDIS_USERNAME,
      password: env.WEBHOOK_WORKER_REDIS_PASSWORD,
      keyPrefix: "webhook:",
      enableAutoPipelining: true,
      ...(env.WEBHOOK_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    worker: {
      concurrency: env.WEBHOOK_WORKER_CONCURRENCY_LIMIT,
      tenantConcurrency: async (environmentId) =>
        (await webhookLimitsForEnvironment(environmentId)).concurrency,
      pollIntervalMs: env.WEBHOOK_WORKER_POLL_INTERVAL,
      shutdownTimeoutMs: env.WEBHOOK_WORKER_SHUTDOWN_TIMEOUT_MS,
      disabled: env.WEBHOOK_ENABLED !== "1" || env.WEBHOOK_WORKER_ENABLED !== "true",
    },
    partitions: {
      ensureSchedule: env.WEBHOOK_PARTITION_ENSURE_SCHEDULE,
      ensureJitterInMs: env.WEBHOOK_PARTITION_ENSURE_JITTER_MS,
      lookaheadDays: env.WEBHOOK_PARTITION_LOOKAHEAD_DAYS,
      retentionDays: env.WEBHOOK_PARTITION_RETENTION_DAYS,
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
      ...waiterStoreConnection(),
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
      const value = await secretStore.getSecret(SigningSecretSchema, key);
      // Fail closed: an unset/empty secret returns undefined so ingest rejects.
      return value?.secret || undefined;
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        let errorType: WebhookDeliverTaskErrorType = "SYSTEM_ERROR";

        if (
          error instanceof ServiceValidationError &&
          errorMessage.includes("queue size limit for this environment has been reached")
        ) {
          errorType = "QUEUE_LIMIT";
        }

        return { success: false, error: errorMessage, errorType };
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

        const wonClaim = await claimSessionStreamPart(environment.id, addressingKey, "in", partId);
        if (wonClaim) {
          const [appendError] = await tryCatch(
            realtimeStream.appendPartToSessionStream(part, partId, addressingKey, "in")
          );
          if (appendError) {
            // Nothing landed — release the claim so a retry re-appends the same id.
            await releaseSessionStreamPart(environment.id, addressingKey, "in", partId);
            // A ServiceValidationError (e.g. record too large) is terminal; anything else is transient.
            if (appendError instanceof ServiceValidationError) {
              return { success: false, error: appendError.message };
            }
            throw appendError;
          }
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        let errorType: WebhookDeliverTaskErrorType = "SYSTEM_ERROR";
        if (
          error instanceof ServiceValidationError &&
          errorMessage.includes("queue size limit for this environment has been reached")
        ) {
          errorType = "QUEUE_LIMIT";
        }
        return { success: false, error: errorMessage, errorType };
      }
    },
  });

  return engine;
}
