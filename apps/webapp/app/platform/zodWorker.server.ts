import type {
  Job as GraphileJob,
  JobHelpers,
  Runner as GraphileRunner,
  RunnerOptions,
  Task,
  TaskList,
  TaskSpec,
} from "graphile-worker";
import { run as graphileRun } from "graphile-worker";
import type { MessageCatalogSchema } from "./messageCatalogSchema.server";

import type { z } from "zod";
import { logger } from "~/services/logger";

export type ZodTasks<TConsumerSchema extends MessageCatalogSchema> = {
  [K in keyof TConsumerSchema]: {
    queueName?: string | ((payload: z.infer<TConsumerSchema[K]>) => string);
    priority?: number;
    maxAttempts?: number;
    jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
    flags?: string[];
    handler: (
      payload: z.infer<TConsumerSchema[K]>,
      job: GraphileJob
    ) => Promise<void>;
  };
};

export type ZodWorkerEnqueueOptions = TaskSpec;

export type ZodWorkerOptions<TMessageCatalog extends MessageCatalogSchema> = {
  runnerOptions: RunnerOptions;
  schema: TMessageCatalog;
  tasks: ZodTasks<TMessageCatalog>;
};

export class ZodWorker<TMessageCatalog extends MessageCatalogSchema> {
  #schema: TMessageCatalog;
  #runnerOptions: RunnerOptions;
  #tasks: ZodTasks<TMessageCatalog>;
  #runner?: GraphileRunner;

  constructor(options: ZodWorkerOptions<TMessageCatalog>) {
    this.#schema = options.schema;
    this.#runnerOptions = options.runnerOptions;
    this.#tasks = options.tasks;
  }

  public async initialize(): Promise<boolean> {
    if (this.#runner) {
      return true;
    }

    logger.debug("Initializing worker queue with options", {
      runnerOptions: this.#runnerOptions,
    });

    this.#runner = await graphileRun({
      ...this.#runnerOptions,
      taskList: this.#createTaskListFromTasks(),
    });

    if (!this.#runner) {
      throw new Error("Failed to initialize worker queue");
    }

    return true;
  }

  public async stop() {
    await this.#runner?.stop();
  }

  public async enqueue<K extends keyof TMessageCatalog>(
    identifier: K,
    payload: z.infer<TMessageCatalog[K]>,
    options?: ZodWorkerEnqueueOptions
  ): Promise<GraphileJob> {
    if (!this.#runner) {
      throw new Error("Worker not initialized");
    }

    const task = this.#tasks[identifier];

    const opts = {
      ...(options || {}),
      ...task,
    };

    if (typeof task.queueName === "function") {
      opts.queueName = task.queueName(payload);
    }

    const job = await this.#runner.addJob(identifier as string, payload, opts);

    logger.debug("Enqueued worker task", {
      identifier,
      payload,
      opts,
      job,
    });

    return job;
  }

  #createTaskListFromTasks() {
    const taskList: TaskList = {};

    for (const [key] of Object.entries(this.#tasks)) {
      const task: Task = (payload, helpers) => {
        return this.#handleMessage(key, payload, helpers);
      };

      taskList[key] = task;
    }

    return taskList;
  }

  async #handleMessage<K extends keyof TMessageCatalog>(
    typeName: K,
    rawPayload: unknown,
    helpers: JobHelpers
  ): Promise<void> {
    const subscriberSchema = this.#schema;
    type TypeKeys = keyof typeof subscriberSchema;

    const messageSchema: TMessageCatalog[TypeKeys] | undefined =
      subscriberSchema[typeName];

    if (!messageSchema) {
      throw new Error(`Unknown message type: ${String(typeName)}`);
    }

    const payload = messageSchema.parse(rawPayload);
    const job = helpers.job;

    logger.debug("Received worker task, calling handler", {
      type: String(typeName),
      payload,
      job,
    });

    const task = this.#tasks[typeName];

    if (!task) {
      throw new Error(`No task for message type: ${String(typeName)}`);
    }

    await task.handler(payload, job);
  }
}
