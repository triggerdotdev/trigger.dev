import { Prisma } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { RuntimeEnvironmentType, TaskRunStatus } from "~/database-types";
import superjson from "superjson";

export interface DataGeneratorOptions {
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  environmentType: RuntimeEnvironmentType;
  payloadSizeKB: number;
  includeComplexPayloads?: boolean;
}

export class TaskRunDataGenerator {
  private readonly taskIdentifiers = [
    "send-email",
    "process-payment",
    "generate-report",
    "sync-data",
    "backup-database",
    "send-notification",
    "process-image",
    "validate-user",
    "cleanup-temp-files",
    "update-analytics",
  ];

  private readonly queues = ["default", "high-priority", "low-priority", "background"];

  private readonly workerQueues = ["main", "worker-1", "worker-2", "worker-3"];

  private readonly statuses: TaskRunStatus[] = [
    "PENDING",
    "EXECUTING",
    "COMPLETED_SUCCESSFULLY",
    "COMPLETED_WITH_ERRORS",
  ];

  private counter = 0;

  constructor(private readonly options: DataGeneratorOptions) {}

  generateBatch(count: number): Prisma.TaskRunCreateInput[] {
    const batch: Prisma.TaskRunCreateInput[] = [];
    for (let i = 0; i < count; i++) {
      batch.push(this.generateInsert());
    }
    return batch;
  }

  generateInsert(): Prisma.TaskRunCreateInput {
    this.counter++;
    const id = nanoid();
    const friendlyId = `run_${this.counter}_${nanoid(8)}`;
    const taskIdentifier =
      this.taskIdentifiers[Math.floor(Math.random() * this.taskIdentifiers.length)];
    const queue = this.queues[Math.floor(Math.random() * this.queues.length)];
    const workerQueue = this.workerQueues[Math.floor(Math.random() * this.workerQueues.length)];

    const payload = this.generatePayload();
    const payloadType = this.options.includeComplexPayloads && Math.random() > 0.7
      ? "application/super+json"
      : "application/json";

    return {
      id,
      friendlyId,
      taskIdentifier,
      payload: payloadType === "application/super+json"
        ? superjson.stringify(payload)
        : JSON.stringify(payload),
      payloadType,
      traceId: nanoid(),
      spanId: nanoid(),
      queue,
      workerQueue,
      runtimeEnvironmentId: this.options.runtimeEnvironmentId,
      projectId: this.options.projectId,
      organizationId: this.options.organizationId,
      environmentType: this.options.environmentType,
      status: "PENDING",
      engine: "V2",
    };
  }

  generateUpdate(runId: string): Prisma.TaskRunUpdateInput {
    const status = this.statuses[Math.floor(Math.random() * this.statuses.length)];

    const update: Prisma.TaskRunUpdateInput = {
      status,
      updatedAt: new Date(),
    };

    // Add timestamps based on status
    if (status === "EXECUTING") {
      update.startedAt = new Date();
      update.executedAt = new Date();
    } else if (status === "COMPLETED_SUCCESSFULLY") {
      update.completedAt = new Date();
      update.usageDurationMs = Math.floor(Math.random() * 10000) + 1000;
    } else if (status === "COMPLETED_WITH_ERRORS") {
      update.completedAt = new Date();
      update.usageDurationMs = Math.floor(Math.random() * 10000) + 1000;
    }

    return update;
  }

  private generatePayload(): any {
    const targetBytes = this.options.payloadSizeKB * 1024;
    const basePayload: any = {
      taskId: nanoid(),
      timestamp: new Date().toISOString(),
      userId: `user_${Math.floor(Math.random() * 10000)}`,
    };

    // Pad the payload to reach target size (do this before adding complex types that can't be JSON.stringified)
    const currentSize = JSON.stringify(basePayload).length;
    if (currentSize < targetBytes) {
      const paddingSize = targetBytes - currentSize;
      basePayload.padding = "x".repeat(paddingSize);
    }

    if (this.options.includeComplexPayloads && Math.random() > 0.5) {
      // Add complex types for superjson (after padding calculation)
      basePayload.bigint = BigInt(Math.floor(Math.random() * 1000000));
      basePayload.date = new Date();
      basePayload.map = new Map([
        ["key1", "value1"],
        ["key2", "value2"],
      ]);
      basePayload.set = new Set([1, 2, 3, 4, 5]);
    }

    return basePayload;
  }

  reset(): void {
    this.counter = 0;
  }
}
