import { Logger } from "@trigger.dev/core/logger";
import { Meter, Tracer } from "@internal/tracing";
import { Prisma, PrismaClient } from "@trigger.dev/database";
import { RedisOptions } from "@internal/redis";

export type SchedulingEnvironment = Prisma.RuntimeEnvironmentGetPayload<{
  include: { project: true; organization: true; orgMember: true };
}>;

export type TriggerScheduledTaskParams = {
  taskIdentifier: string;
  environment: SchedulingEnvironment;
  payload: {
    scheduleId: string;
    type: "DECLARATIVE" | "IMPERATIVE";
    timestamp: Date;
    lastTimestamp?: Date;
    externalId?: string;
    timezone: string;
    upcoming: Date[];
  };
  scheduleInstanceId: string;
  scheduleId: string;
  exactScheduleTime?: Date;
};

export type TriggerScheduledTaskErrorType = "QUEUE_LIMIT" | "SYSTEM_ERROR";

export interface TriggerScheduledTaskCallback {
  (params: TriggerScheduledTaskParams): Promise<{
    success: boolean;
    error?: string;
    errorType?: TriggerScheduledTaskErrorType;
  }>;
}

export interface ScheduleEngineOptions {
  logger?: Logger;
  logLevel?: string;
  prisma: PrismaClient;
  redis: RedisOptions;
  worker: {
    concurrency: number;
    workers?: number;
    tasksPerWorker?: number;
    pollIntervalMs?: number;
    shutdownTimeoutMs?: number;
    disabled?: boolean;
  };
  distributionWindow?: {
    seconds: number;
  };
  tracer?: Tracer;
  meter?: Meter;
  onTriggerScheduledTask: TriggerScheduledTaskCallback;
  isDevEnvironmentConnectedHandler: (environmentId: string) => Promise<boolean>;
  onRegisterScheduleInstance?: (instanceId: string) => Promise<void>;
}

export interface UpsertScheduleParams {
  projectId: string;
  schedule: {
    friendlyId?: string;
    taskIdentifier: string;
    deduplicationKey?: string;
    cron: string;
    timezone?: string;
    externalId?: string;
    environments: string[];
  };
}

export interface TriggerScheduleParams {
  instanceId: string;
  finalAttempt: boolean;
  exactScheduleTime?: Date;
  lastScheduleTime?: Date;
}

export interface RegisterScheduleInstanceParams {
  instanceId: string;
  /**
   * Anchor for computing the next cron slot. Defaults to now() when omitted.
   * This advances on every tick (fired or skipped) so the next slot keeps
   * marching forward regardless of skip reasons.
   */
  fromTimestamp?: Date;
  /**
   * The actual previous fire time to embed in the next worker job's payload,
   * which becomes that job's `payload.lastTimestamp` on dequeue. Distinct
   * from `fromTimestamp` so that skipped ticks (inactive schedule, dev env
   * disconnected, etc.) do NOT advance this — only real fires do.
   */
  lastScheduleTime?: Date;
}
