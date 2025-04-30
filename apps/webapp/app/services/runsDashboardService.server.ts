import type { ClickHouse } from "@internal/clickhouse";
import { TaskRunError } from "@trigger.dev/core/v3/schemas";
import { RuntimeEnvironmentType, TaskRun, TaskRunStatus } from "@trigger.dev/database";
import { logger } from "./logger.server";
import { EventEmitter } from "node:events";
import { parsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import { EventBusEvents } from "@internal/run-engine";

export class RunsDashboardService {
  constructor(private readonly clickhouse: ClickHouse) {}

  private readonly logger = logger.child({
    service: "RunsDashboardService",
  });

  async runAttemptStarted(event: RunDashboardEventRunAttemptStarted) {
    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: event.environment.id,
      organization_id: event.organization.id,
      project_id: event.project.id,
      run_id: event.run.id,
      status: event.run.status,
      attempt: event.run.attemptNumber ?? 1,
      event_time: event.time.getTime(),
      updated_at: event.run.updatedAt.getTime(),
      base_cost_in_cents: event.run.baseCostInCents,
      executed_at: event.run.executedAt ? event.run.executedAt.getTime() : undefined,
      event_name: "attempt_started",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: runAttemptStarted", {
        error: insertError,
        event,
      });
    }

    return insertResult?.executed === true;
  }

  async runEnqueuedAfterDelay(event: RunDashboardEventRunEnqueuedAfterDelay) {
    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: event.environment.id,
      organization_id: event.organization.id,
      project_id: event.project.id,
      run_id: event.run.id,
      status: event.run.status,
      event_time: event.time.getTime(),
      updated_at: event.run.updatedAt.getTime(),
      event_name: "enqueued_after_delay",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: runEnqueuedAfterDelay", {
        error: insertError,
        event,
      });
    }

    return insertResult?.executed === true;
  }

  async runDelayRescheduled(event: RunDashboardEventRunDelayRescheduled) {
    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: event.environment.id,
      organization_id: event.organization.id,
      project_id: event.project.id,
      run_id: event.run.id,
      status: event.run.status,
      event_time: event.time.getTime(),
      updated_at: event.run.updatedAt.getTime(),
      delay_until: event.run.delayUntil ? event.run.delayUntil.getTime() : undefined,
      event_name: "delay_rescheduled",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: runDelayRescheduled", {
        error: insertError,
        event,
      });
    }

    return insertResult?.executed === true;
  }

  async runLocked(event: RunDashboardEventRunLocked) {
    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: event.environment.id,
      organization_id: event.organization.id,
      project_id: event.project.id,
      run_id: event.run.id,
      status: event.run.status,
      event_time: event.time.getTime(),
      updated_at: event.run.updatedAt.getTime(),
      base_cost_in_cents: event.run.baseCostInCents,
      task_version: event.run.taskVersion ?? undefined,
      sdk_version: event.run.sdkVersion ?? undefined,
      cli_version: event.run.cliVersion ?? undefined,
      machine_preset: event.run.machinePreset ?? undefined,
      executed_at: event.run.startedAt ? event.run.startedAt.getTime() : undefined,
      event_name: "locked",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: runLocked", {
        error: insertError,
        event,
      });
    }

    return insertResult?.executed === true;
  }

  async runStatusChanged(event: RunDashboardEventRunStatusChanged) {
    if (!event.organization.id || !event.project.id || !event.environment.id) {
      return false;
    }

    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: event.environment.id,
      organization_id: event.organization.id,
      project_id: event.project.id,
      run_id: event.run.id,
      status: event.run.status,
      event_time: event.time.getTime(),
      updated_at: event.run.updatedAt.getTime(),
      event_name: "status_changed",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: runStatusChanged", {
        error: insertError,
        event,
      });
    }

    return insertResult?.executed === true;
  }

  async runExpired(event: RunDashboardEventRunExpired) {
    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: event.environment.id,
      organization_id: event.organization.id,
      project_id: event.project.id,
      run_id: event.run.id,
      status: event.run.status,
      event_time: event.time.getTime(),
      updated_at: event.run.updatedAt.getTime(),
      expired_at: event.run.expiredAt ? event.run.expiredAt.getTime() : undefined,
      event_name: "run_expired",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: runExpired", {
        error: insertError,
        event,
      });
    }

    return insertResult?.executed === true;
  }

  async runSucceeded(event: RunDashboardEventRunSucceeded) {
    const output = await this.#prepareOutput(event.run);

    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: event.environment.id,
      organization_id: event.organization.id,
      project_id: event.project.id,
      run_id: event.run.id,
      status: event.run.status,
      event_time: event.time.getTime(),
      updated_at: event.run.updatedAt.getTime(),
      completed_at: event.run.completedAt ? event.run.completedAt.getTime() : undefined,
      usage_duration_ms: event.run.usageDurationMs,
      cost_in_cents: event.run.costInCents,
      output: output,
      attempt: event.run.attemptNumber,
      event_name: "succeeded",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: runSucceeded", {
        error: insertError,
        event,
      });
    }

    return insertResult?.executed === true;
  }

  async runFailed(event: RunDashboardEventRunFailed) {
    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: event.environment.id,
      organization_id: event.organization.id,
      project_id: event.project.id,
      run_id: event.run.id,
      status: event.run.status,
      event_time: event.time.getTime(),
      updated_at: event.run.updatedAt.getTime(),
      completed_at: event.run.completedAt ? event.run.completedAt.getTime() : undefined,
      error: event.run.error,
      attempt: event.run.attemptNumber,
      usage_duration_ms: event.run.usageDurationMs,
      cost_in_cents: event.run.costInCents,
      event_name: "failed",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: runFailed", {
        error: insertError,
        event,
      });
    }

    return insertResult?.executed === true;
  }

  async runRetryScheduled(event: RunDashboardEventRunRetryScheduled) {
    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: event.environment.id,
      organization_id: event.organization.id,
      project_id: event.environment.projectId,
      run_id: event.run.id,
      status: event.run.status,
      event_time: event.time.getTime(),
      updated_at: event.run.updatedAt.getTime(),
      machine_preset: event.run.nextMachineAfterOOM ?? undefined,
      attempt: event.run.attemptNumber,
      error: event.run.error,
      event_name: "retry_scheduled",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: runRetryScheduled", {
        error: insertError,
        event,
      });
    }

    return insertResult?.executed === true;
  }

  async runCancelled(event: RunDashboardEventRunCancelled) {
    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: event.environment.id,
      organization_id: event.organization.id,
      project_id: event.project.id,
      run_id: event.run.id,
      status: event.run.status,
      event_time: event.time.getTime(),
      updated_at: event.run.updatedAt.getTime(),
      completed_at: event.run.completedAt ? event.run.completedAt.getTime() : undefined,
      error: event.run.error ? (event.run.error as TaskRunError) : undefined,
      attempt: event.run.attemptNumber,
      event_name: "cancelled",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: runCancelled", {
        error: insertError,
        event,
      });
    }

    return insertResult?.executed === true;
  }

  async runTagsUpdated(event: RunDashboardEventRunTagsUpdated) {
    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: event.environment.id,
      organization_id: event.organization.id,
      project_id: event.project.id,
      run_id: event.run.id,
      status: event.run.status,
      event_time: event.time.getTime(),
      updated_at: event.run.updatedAt.getTime(),
      tags: event.run.tags,
      event_name: "tags_updated",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: runTagsUpdated", {
        error: insertError,
        event,
      });
    }

    return insertResult?.executed === true;
  }

  async runCreated(
    eventTime: Date,
    taskRun: TaskRun,
    environmentType: RuntimeEnvironmentType,
    organizationId: string
  ) {
    const payload = await this.#preparePayload(taskRun);

    const [insertError, insertResult] = await this.clickhouse.runEvents.insert({
      environment_id: taskRun.runtimeEnvironmentId,
      environment_type: environmentType,
      organization_id: organizationId,
      project_id: taskRun.projectId,
      run_id: taskRun.id,
      friendly_id: taskRun.friendlyId,
      attempt: taskRun.attemptNumber ?? 1,
      engine: taskRun.engine,
      status: taskRun.status,
      task_identifier: taskRun.taskIdentifier,
      queue: taskRun.queue,
      schedule_id: taskRun.scheduleId ?? undefined,
      batch_id: taskRun.batchId ?? undefined,
      event_time: eventTime.getTime(),
      created_at: taskRun.createdAt.getTime(),
      updated_at: taskRun.updatedAt.getTime(),
      completed_at: taskRun.completedAt ? taskRun.completedAt.getTime() : undefined,
      started_at: taskRun.startedAt ? taskRun.startedAt.getTime() : undefined,
      executed_at: taskRun.executedAt ? taskRun.executedAt.getTime() : undefined,
      delay_until: taskRun.delayUntil ? taskRun.delayUntil.getTime() : undefined,
      queued_at: taskRun.queuedAt ? taskRun.queuedAt.getTime() : undefined,
      expired_at: taskRun.expiredAt ? taskRun.expiredAt.getTime() : undefined,
      usage_duration_ms: taskRun.usageDurationMs,
      tags: taskRun.runTags,
      payload: payload,
      task_version: taskRun.taskVersion ?? undefined,
      sdk_version: taskRun.sdkVersion ?? undefined,
      cli_version: taskRun.cliVersion ?? undefined,
      machine_preset: taskRun.machinePreset ?? undefined,
      is_test: taskRun.isTest ?? false,
      root_run_id: taskRun.rootTaskRunId ?? undefined,
      parent_run_id: taskRun.parentTaskRunId ?? undefined,
      depth: taskRun.depth ?? 0,
      span_id: taskRun.spanId ?? undefined,
      trace_id: taskRun.traceId ?? undefined,
      idempotency_key: taskRun.idempotencyKey ?? undefined,
      expiration_ttl: taskRun.ttl ?? undefined,
      cost_in_cents: taskRun.costInCents ?? undefined,
      base_cost_in_cents: taskRun.baseCostInCents ?? undefined,
      event_name: "created",
    });

    if (insertError) {
      this.logger.error("RunsDashboardService: upsertRun", {
        error: insertError,
        taskRun,
      });
    } else {
      this.logger.info("RunsDashboardService: upsertRun", {
        id: taskRun.id,
        friendlyId: taskRun.friendlyId,
        status: taskRun.status,
      });
    }

    return insertResult?.executed === true;
  }

  async #preparePayload(run: TaskRun): Promise<unknown | undefined> {
    if (run.status !== "PENDING" && run.status !== "DELAYED") {
      return undefined;
    }

    if (run.payloadType !== "application/json" && run.payloadType !== "application/super+json") {
      return undefined;
    }

    const packet = {
      data: run.payload,
      dataType: run.payloadType,
    };

    return await parsePacket(packet);
  }

  async #prepareOutput(run: {
    output: string | undefined;
    outputType: string;
  }): Promise<unknown | undefined> {
    if (!run.output) {
      return undefined;
    }

    if (run.outputType !== "application/json" && run.outputType !== "application/super+json") {
      return undefined;
    }

    const packet = {
      data: run.output,
      dataType: run.outputType,
    };

    return await parsePacket(packet);
  }

  async #prepareMetadata(run: {
    metadata: string | undefined;
    metadataType: string;
  }): Promise<unknown | undefined> {
    if (!run.metadata) {
      return undefined;
    }

    if (run.metadataType !== "application/json" && run.metadataType !== "application/super+json") {
      return undefined;
    }

    const packet = {
      data: run.metadata,
      dataType: run.metadataType,
    };

    return await parsePacket(packet);
  }
}

export type RunDashboardEvents = {
  runCreated: [
    {
      time: Date;
      runId: string;
    }
  ];
  runEnqueuedAfterDelay: EventBusEvents["runEnqueuedAfterDelay"];
  runDelayRescheduled: EventBusEvents["runDelayRescheduled"];
  runLocked: EventBusEvents["runLocked"];
  runStatusChanged: EventBusEvents["runStatusChanged"];
  runAttemptStarted: EventBusEvents["runAttemptStarted"];
  runExpired: EventBusEvents["runExpired"];
  runSucceeded: EventBusEvents["runSucceeded"];
  runFailed: EventBusEvents["runFailed"];
  runRetryScheduled: EventBusEvents["runRetryScheduled"];
  runCancelled: EventBusEvents["runCancelled"];
  runTagsUpdated: [
    {
      time: Date;
      run: {
        id: string;
        tags: string[];
        status: TaskRunStatus;
        updatedAt: Date;
      };
      organization: {
        id: string;
      };
      project: {
        id: string;
      };
      environment: {
        id: string;
      };
    }
  ];
};

export type RunDashboardEventArgs<T extends keyof RunDashboardEvents> = RunDashboardEvents[T];
export type RunDashboardEventBus = EventEmitter<RunDashboardEvents>;
export type RunDashboardEventRunAttemptStarted = RunDashboardEventArgs<"runAttemptStarted">[0];
export type RunDashboardEventRunCreated = RunDashboardEventArgs<"runCreated">[0];
export type RunDashboardEventRunEnqueuedAfterDelay =
  RunDashboardEventArgs<"runEnqueuedAfterDelay">[0];
export type RunDashboardEventRunDelayRescheduled = RunDashboardEventArgs<"runDelayRescheduled">[0];
export type RunDashboardEventRunLocked = RunDashboardEventArgs<"runLocked">[0];
export type RunDashboardEventRunStatusChanged = RunDashboardEventArgs<"runStatusChanged">[0];
export type RunDashboardEventRunExpired = RunDashboardEventArgs<"runExpired">[0];
export type RunDashboardEventRunSucceeded = RunDashboardEventArgs<"runSucceeded">[0];
export type RunDashboardEventRunFailed = RunDashboardEventArgs<"runFailed">[0];
export type RunDashboardEventRunRetryScheduled = RunDashboardEventArgs<"runRetryScheduled">[0];
export type RunDashboardEventRunCancelled = RunDashboardEventArgs<"runCancelled">[0];
export type RunDashboardEventRunTagsUpdated = RunDashboardEventArgs<"runTagsUpdated">[0];
