import type { Logger } from "@trigger.dev/core/logger";
import type { OutputPayload, OutputPayloadV2 } from "./types.js";
import { z } from "zod";

const WorkerQueueOverrides = z.object({
  environmentId: z.record(z.string(), z.string()).optional(),
  projectId: z.record(z.string(), z.string()).optional(),
  orgId: z.record(z.string(), z.string()).optional(),
  workerQueue: z.record(z.string(), z.string()).optional(),
});

export type WorkerQueueOverrides = z.infer<typeof WorkerQueueOverrides>;

export type WorkerQueueResolverOptions = {
  logger: Logger;
  overrideConfig?: string;
};

export class WorkerQueueResolver {
  private overrides: WorkerQueueOverrides | null;
  private logger: Logger;

  constructor(opts: WorkerQueueResolverOptions) {
    this.logger = opts.logger;
    this.overrides = this.parseOverrides(opts.overrideConfig);
  }

  private parseOverrides(overrideConfig?: string): WorkerQueueOverrides | null {
    const overridesJson = overrideConfig ?? process.env.RUN_ENGINE_WORKER_QUEUE_OVERRIDES;

    if (!overridesJson) {
      return null;
    }

    try {
      const parsed = JSON.parse(overridesJson);
      const result = WorkerQueueOverrides.safeParse(parsed);

      if (!result.success) {
        this.logger.error("Invalid worker queue overrides format", {
          error: result.error.format(),
        });
        return null;
      }

      this.logger.info("🎯 Worker queue overrides enabled", { overrides: result.data });

      return result.data;
    } catch (error) {
      this.logger.error("Failed to parse worker queue overrides json", {
        error,
      });
      return null;
    }
  }

  public getWorkerQueueFromMessage(message: OutputPayload): string {
    if (message.version === "2") {
      // Check overrides in priority order
      const override = this.#getOverride(message);
      if (override) return override;

      return message.workerQueue;
    }

    // In v2, if the environment is development, the worker queue is the environment id.
    if (message.environmentType === "DEVELOPMENT") {
      return message.environmentId;
    }

    // In v1, the master queue is something like us-nyc-3,
    // which in v2 is the worker queue.
    return message.masterQueues[0];
  }

  #getOverride(message: OutputPayloadV2): string | null {
    if (!this.overrides) {
      return null;
    }

    // Priority: environmentId > projectId > orgId > workerQueue
    if (this.overrides.environmentId?.[message.environmentId]) {
      return this.overrides.environmentId[message.environmentId];
    }

    if (this.overrides.projectId?.[message.projectId]) {
      return this.overrides.projectId[message.projectId];
    }

    if (this.overrides.orgId?.[message.orgId]) {
      return this.overrides.orgId[message.orgId];
    }

    if (this.overrides.workerQueue?.[message.workerQueue]) {
      return this.overrides.workerQueue[message.workerQueue];
    }

    return null;
  }
}
