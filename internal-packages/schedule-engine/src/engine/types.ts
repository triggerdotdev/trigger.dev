import { Logger } from "@trigger.dev/core/logger";
import { Meter, Tracer } from "@internal/tracing";
import { PrismaClient } from "@trigger.dev/database";
import { RedisOptions } from "@internal/redis";

export type TriggerScheduledTaskParams = {
  taskIdentifier: string;
  environment: any; // The full environment object from the database with all relationships
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

export interface TriggerScheduledTaskCallback {
  (params: TriggerScheduledTaskParams): Promise<{ success: boolean; error?: string }>;
}

export interface ScheduleEngineOptions {
  logger?: Logger;
  logLevel?: string;
  prisma: PrismaClient;
  redis: RedisOptions;
  worker: {
    concurrency: number;
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
}

export interface RegisterScheduleInstanceParams {
  instanceId: string;
}
