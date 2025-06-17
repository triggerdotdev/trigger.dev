import { ScheduleEngine } from "@internal/schedule-engine";
import { stringifyIO } from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { devPresence } from "~/presenters/v3/DevPresence.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { TriggerTaskService } from "./services/triggerTask.server";
import { meter, tracer } from "./tracer.server";

export const scheduleEngine = singleton("ScheduleEngine", createScheduleEngine);

export type { ScheduleEngine };

async function isDevEnvironmentConnectedHandler(environmentId: string) {
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: environmentId,
    },
    select: {
      currentSession: {
        select: {
          disconnectedAt: true,
        },
      },
      project: {
        select: {
          engine: true,
        },
      },
    },
  });

  if (!environment) {
    return false;
  }

  if (environment.project.engine === "V1") {
    const v3Disconnected = !environment.currentSession || environment.currentSession.disconnectedAt;

    return !v3Disconnected;
  }

  const v4Connected = await devPresence.isConnected(environmentId);

  return v4Connected;
}

function createScheduleEngine() {
  const engine = new ScheduleEngine({
    prisma,
    logLevel: env.SCHEDULE_ENGINE_LOG_LEVEL,
    redis: {
      host: env.SCHEDULE_WORKER_REDIS_HOST ?? "localhost",
      port: env.SCHEDULE_WORKER_REDIS_PORT ?? 6379,
      username: env.SCHEDULE_WORKER_REDIS_USERNAME,
      password: env.SCHEDULE_WORKER_REDIS_PASSWORD,
      keyPrefix: "schedule:",
      enableAutoPipelining: true,
      ...(env.SCHEDULE_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    worker: {
      concurrency: env.SCHEDULE_WORKER_CONCURRENCY_LIMIT,
      pollIntervalMs: env.SCHEDULE_WORKER_POLL_INTERVAL,
      shutdownTimeoutMs: env.SCHEDULE_WORKER_SHUTDOWN_TIMEOUT_MS,
      disabled: env.SCHEDULE_WORKER_ENABLED === "0",
    },
    distributionWindow: {
      seconds: env.SCHEDULE_WORKER_DISTRIBUTION_WINDOW_SECONDS,
    },
    tracer,
    meter,
    onTriggerScheduledTask: async ({
      taskIdentifier,
      environment,
      payload,
      scheduleInstanceId,
      scheduleId,
      exactScheduleTime,
    }) => {
      try {
        // This will trigger either v1 or v2 depending on the engine of the project
        const triggerService = new TriggerTaskService();

        const payloadPacket = await stringifyIO(payload);

        logger.debug("Triggering scheduled task", {
          taskIdentifier,
          environment,
          payload,
          scheduleInstanceId,
          scheduleId,
          exactScheduleTime,
        });

        const result = await triggerService.call(
          taskIdentifier,
          environment,
          { payload: payloadPacket.data, options: { payloadType: payloadPacket.dataType } },
          {
            customIcon: "scheduled",
            scheduleId,
            scheduleInstanceId,
            queueTimestamp: exactScheduleTime,
            overrideCreatedAt: exactScheduleTime,
          }
        );

        return { success: !!result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    isDevEnvironmentConnectedHandler: isDevEnvironmentConnectedHandler,
  });

  return engine;
}
