import type {
  Job as GraphileJob,
  Runner as GraphileRunner,
  JobHelpers,
  RunnerOptions,
  Task,
  TaskList,
  TaskSpec,
} from "graphile-worker";
import { run as graphileRun } from "graphile-worker";

import omit from "lodash.omit";
import { z } from "zod";
import { PrismaClient, PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";

export interface MessageCatalogSchema {
  [key: string]: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;
}

const GraphileJobSchema = z.object({
  id: z.coerce.string(),
  queue_name: z.string().nullable(),
  task_identifier: z.string(),
  payload: z.unknown(),
  priority: z.number(),
  run_at: z.coerce.date(),
  attempts: z.number(),
  max_attempts: z.number(),
  last_error: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  key: z.string().nullable(),
  revision: z.number(),
  locked_at: z.coerce.date().nullable(),
  locked_by: z.string().nullable(),
  flags: z.record(z.boolean()).nullable(),
});

const AddJobResultsSchema = z.array(GraphileJobSchema);

export type ZodTasks<TConsumerSchema extends MessageCatalogSchema> = {
  [K in keyof TConsumerSchema]: {
    queueName?: string | ((payload: z.infer<TConsumerSchema[K]>) => string);
    priority?: number;
    maxAttempts?: number;
    jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
    flags?: string[];
    handler: (payload: z.infer<TConsumerSchema[K]>, job: GraphileJob) => Promise<void>;
  };
};

export type ZodWorkerEnqueueOptions = TaskSpec & {
  tx?: PrismaClientOrTransaction;
};

export type ZodWorkerOptions<TMessageCatalog extends MessageCatalogSchema> = {
  runnerOptions: RunnerOptions;
  prisma: PrismaClient;
  schema: TMessageCatalog;
  tasks: ZodTasks<TMessageCatalog>;
};

export class ZodWorker<TMessageCatalog extends MessageCatalogSchema> {
  #schema: TMessageCatalog;
  #prisma: PrismaClient;
  #runnerOptions: RunnerOptions;
  #tasks: ZodTasks<TMessageCatalog>;
  #runner?: GraphileRunner;

  constructor(options: ZodWorkerOptions<TMessageCatalog>) {
    this.#schema = options.schema;
    this.#prisma = options.prisma;
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

    const optionsWithoutTx = omit(options ?? {}, ["tx"]);

    const spec = {
      ...optionsWithoutTx,
      ...task,
    };

    if (typeof task.queueName === "function") {
      spec.queueName = task.queueName(payload);
    }

    const job = await this.#addJob(
      identifier as string,
      payload,
      spec,
      options?.tx ?? this.#prisma
    );

    logger.debug("Enqueued worker task", {
      identifier,
      payload,
      spec,
      job,
    });

    return job;
  }

  async #addJob(
    identifier: string,
    payload: unknown,
    spec: TaskSpec,
    tx: PrismaClientOrTransaction
  ) {
    const results = await tx.$queryRawUnsafe(
      `SELECT * FROM graphile_worker.add_job(
          identifier => $1::text,
          payload => $2::json,
          queue_name => $3::text,
          run_at => $4::timestamptz,
          max_attempts => $5::int,
          job_key => $6::text,
          priority => $7::int,
          flags => $8::text[],
          job_key_mode => $9::text
        )`,
      identifier,
      JSON.stringify(payload),
      spec.queueName || null,
      spec.runAt || null,
      spec.maxAttempts || null,
      spec.jobKey || null,
      spec.priority || null,
      spec.jobKeyMode || null,
      spec.flags || null
    );

    const rows = AddJobResultsSchema.safeParse(results);

    if (!rows.success) {
      throw new Error(
        `Failed to add job to queue, zod parsing error: ${JSON.stringify(rows.error)}`
      );
    }

    const job = rows.data[0];

    return job as GraphileJob;
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

    const messageSchema: TMessageCatalog[TypeKeys] | undefined = subscriberSchema[typeName];

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
