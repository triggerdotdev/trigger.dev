import { WebhookEngine } from "@internal/webhook-engine";
import type { WebhookDeliverTaskErrorType } from "@internal/webhook-engine";
import { tryCatch } from "@trigger.dev/core/utils";
import { z } from "zod";
import { prisma, webhookPrisma } from "~/db.server";
import { env } from "~/env.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import {
  ensureRunForSession,
  type SessionTriggerConfig,
} from "~/services/realtime/sessionRunManager.server";
import { findOrCreateSession, findSessionByExternalId } from "~/services/realtime/sessions.server";
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
import { meter, tracer } from "./tracer.server";

export const webhookEngine = singleton("WebhookEngine", createWebhookEngine);

export type { WebhookEngine };

// The plaintext signing secret is stored under the "DATABASE" SecretStore
// provider as { secret: string } (same shape as environment variables).
const SigningSecretSchema = z.object({ secret: z.string() });

function createWebhookEngine() {
  // The engine owns the webhook tables, so it runs on the webhook DB client. The signing-secret
  // store stays on the main client below (SecretStore is control-plane, not part of the split).
  const secretStore = getSecretStore("DATABASE", { prismaClient: prisma });

  const engine = new WebhookEngine({
    prisma: webhookPrisma,
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
      workers: env.WEBHOOK_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.WEBHOOK_WORKER_CONCURRENCY_TASKS_PER_WORKER,
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
    tracer,
    meter,
    resolveSigningSecret: async (key) => {
      const value = await secretStore.getSecret(SigningSecretSchema, key);
      // Fail closed: an unset/empty secret returns undefined so ingest rejects.
      return value?.secret || undefined;
    },
    triggerTask: async ({
      environmentId,
      taskId,
      idempotencyKey,
      idempotencyKeyExpiresAt,
      payload,
      headers,
      identityTags,
      endpointMetadata,
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
            // The webhook task run receives a { event, headers } envelope; the SDK's webhook()
            // run unwraps it into onEvent({ event, headers }).
            payload: { event: payload, headers },
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
    // Route a verified delivery to a session: find-or-create it, then append a webhook action to `.in`.
    // The run boots on a preload payload (so onChatStart fires), then reads the action from `.in`.
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
      triggerConfigTemplate,
      isSessionStart,
    }) => {
      try {
        const environment = await findEnvironmentById(environmentId);
        if (!environment) {
          return { success: false, errorType: "NOT_FOUND", error: "Environment not found" };
        }

        const template = (triggerConfigTemplate ?? {}) as Partial<SessionTriggerConfig>;
        const triggerConfig: SessionTriggerConfig = {
          ...template,
          basePayload: {
            messages: [],
            trigger: "preload",
            chatId: externalId,
            ...(template.basePayload ?? {}),
          },
        };

        // Resume an existing session; otherwise only START one when the event is a session-start
        // (startOn). Resume-only with no session yet -> ignore (no session, no run, no egress).
        const existing = await findSessionByExternalId(environment, externalId);
        if (!existing && !isSessionStart) {
          return {
            success: true,
            skipped: true,
            skippedReason: "startOn: not a session-start event",
          };
        }
        const { session, isCached } = existing
          ? { session: existing, isCached: true }
          : await findOrCreateSession({
              environment,
              externalId,
              type: "chat.agent",
              taskIdentifier,
              triggerConfig,
            });

        if (session.closedAt || (session.expiresAt && session.expiresAt.getTime() < Date.now())) {
          return { success: false, error: "Session is closed or expired" };
        }

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
                channelEvent: { connectorId, event, source, headers, deliveryId },
              }
            : {
                chatId: externalId,
                trigger: "action",
                actionSource: "webhook",
                action: { type: actionType, event, source, headers, deliveryId },
              };
        const part = JSON.stringify({ kind: "message", payload });

        // deliveryId as the part id → a deliver-job retry re-claims the same id and skips a duplicate
        // append. The S2 record is durable, so a run that boots later still reads it.
        const wonClaim = await claimSessionStreamPart(
          environment.id,
          addressingKey,
          "in",
          deliveryId
        );
        if (wonClaim) {
          const [appendError] = await tryCatch(
            realtimeStream.appendPartToSessionStream(part, deliveryId, addressingKey, "in")
          );
          if (appendError) {
            // Nothing landed — release the claim so a retry re-appends the same id.
            await releaseSessionStreamPart(environment.id, addressingKey, "in", deliveryId);
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
