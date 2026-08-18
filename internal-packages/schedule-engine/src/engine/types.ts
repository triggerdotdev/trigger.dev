import type { Logger } from "@trigger.dev/core/logger";
import type { Meter, Tracer } from "@internal/tracing";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "@internal/redis";

type SchedulingEnvironment = Prisma.RuntimeEnvironmentGetPayload<{
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
  exactScheduleTime: Date;
  effectiveScheduleTime: Date;
};

export type TriggerScheduledTaskErrorType = "QUEUE_LIMIT" | "OUT_OF_ENTITLEMENTS" | "SYSTEM_ERROR";

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
  schedulePhaseSecret: string | Buffer;
  /**
   * Fraction of schedules (0 to 1) with cron spread active, gated on each
   * schedule's deterministic phase. 0 disables spreading entirely; 1 enables
   * it for every schedule. Raising the fraction is strictly additive — phases
   * are stable, so a schedule never leaves the rollout once included.
   */
  cronSpreadFraction: number;
  tracer?: Tracer;
  meter?: Meter;
  onTriggerScheduledTask: TriggerScheduledTaskCallback;
  isDevEnvironmentConnectedHandler: (environmentId: string) => Promise<boolean>;
  onRegisterScheduleInstance?: (instanceId: string) => Promise<void>;
}

export interface TriggerScheduleParams {
  instanceId: string;
  finalAttempt: boolean;
  exactScheduleTime?: Date;
  effectiveScheduleTime?: Date;
  lastScheduleTime?: Date;
}

export interface RegisterScheduleInstanceParams {
  instanceId: string;
  /**
   * Nominal anchor for selecting the next non-expired cron occurrence. Defaults
   * to now() when omitted. The engine advances from this timestamp when the
   * next occurrence is still eligible and skips expired intermediate ticks.
   */
  fromTimestamp?: Date;
  /**
   * The actual previous fire time to embed in the next worker job's payload,
   * which becomes that job's `payload.lastTimestamp` on dequeue. Distinct
   * from `fromTimestamp` so that skipped ticks (inactive schedule, dev env
   * disconnected, etc.) do NOT advance this — only real fires do.
   */
  lastScheduleTime?: Date;
  /**
   * Keep an existing stable-ID Redis job unchanged, while still creating it
   * when missing. Intended for no-op reconciliation of unchanged schedules.
   */
  preserveExistingJob?: boolean;
}
