import type { ClickHouse } from "@internal/clickhouse";
import { EventBusEvents } from "@internal/run-engine";
import { parsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import { RuntimeEnvironmentType, TaskRun, TaskRunStatus } from "@trigger.dev/database";
import { EventEmitter } from "node:events";
import { logger } from "./logger.server";

export class RunsDashboardService {
  constructor(private readonly clickhouse: ClickHouse) {}

  private readonly logger = logger.child({
    service: "RunsDashboardService",
  });

  async runAttemptStarted(event: RunDashboardEventRunAttemptStarted) {
    // Noop for now
  }

  async runEnqueuedAfterDelay(event: RunDashboardEventRunEnqueuedAfterDelay) {
    // Noop for now
  }

  async runDelayRescheduled(event: RunDashboardEventRunDelayRescheduled) {
    // Noop for now
  }

  async runLocked(event: RunDashboardEventRunLocked) {
    // Noop for now
  }

  async runStatusChanged(event: RunDashboardEventRunStatusChanged) {
    // Noop for now
  }

  async runExpired(event: RunDashboardEventRunExpired) {
    // Noop for now
  }

  async runSucceeded(event: RunDashboardEventRunSucceeded) {
    // Noop for now
  }

  async runFailed(event: RunDashboardEventRunFailed) {
    // Noop for now
  }

  async runRetryScheduled(event: RunDashboardEventRunRetryScheduled) {
    // Noop for now
  }

  async runCancelled(event: RunDashboardEventRunCancelled) {
    // Noop for now
  }

  async runTagsUpdated(event: RunDashboardEventRunTagsUpdated) {
    // Noop for now
  }

  async runCreated(
    eventTime: Date,
    taskRun: TaskRun,
    environmentType: RuntimeEnvironmentType,
    organizationId: string
  ) {
    // Noop for now
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
        createdAt: Date;
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
