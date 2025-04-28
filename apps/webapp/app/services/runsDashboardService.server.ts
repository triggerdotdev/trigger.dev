import type { ClickHouse } from "@internal/clickhouse";
import { TaskRunError } from "@trigger.dev/core/v3/schemas";
import { RuntimeEnvironmentType, TaskRun } from "@trigger.dev/database";
import { logger } from "./logger.server";
import { EventEmitter } from "node:events";
import { parsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";

export class RunsDashboardService {
  constructor(private readonly clickhouse: ClickHouse) {}

  private readonly logger = logger.child({
    service: "RunsDashboardService",
  });

  async upsertRun(
    taskRun: TaskRun,
    environmentType: RuntimeEnvironmentType,
    organizationId: string
  ) {
    const [payload, output] = await Promise.all([
      this.#preparePayload(taskRun),
      this.#prepareOutput(taskRun),
    ]);

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
      event_time: Date.now(),
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
      output: output,
      error: taskRun.error ? (taskRun.error as TaskRunError) : undefined,
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

  async #prepareOutput(run: TaskRun): Promise<unknown | undefined> {
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
}

export type RunDashboardEvents = {
  runStatusUpdate: [
    {
      run: TaskRun;
      organization: {
        id: string;
      };
      environment: {
        type: RuntimeEnvironmentType;
      };
    }
  ];
};

export type RunDashboardEventArgs<T extends keyof RunDashboardEvents> = RunDashboardEvents[T];
export type RunDashboardEventBus = EventEmitter<RunDashboardEvents>;
