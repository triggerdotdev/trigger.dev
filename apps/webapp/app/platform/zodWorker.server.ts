import type {
  CronItem,
  CronItemOptions,
  Job as GraphileJob,
  Runner as GraphileRunner,
  JobHelpers,
  RunnerOptions,
  Task,
  TaskList,
  TaskSpec,
} from "graphile-worker";
import { run as graphileRun, parseCronItems } from "graphile-worker";

import omit from "lodash.omit";
import { z } from "zod";
import { PrismaClient, PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";

export interface MessageCatalogSchema {
  [key: string]: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;
}

const RawCronPayloadSchema = z.object({
  _cron: z.object({
    ts: z.coerce.date(),
    backfilled: z.boolean(),
  }),
});

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
    jobKey?: string | ((payload: z.infer<TConsumerSchema[K]>) => string | undefined);
    priority?: number;
    maxAttempts?: number;
    jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
    flags?: string[];
    handler: (payload: z.infer<TConsumerSchema[K]>, job: GraphileJob) => Promise<void>;
  };
};

type RecurringTaskPayload = {
  ts: Date;
  backfilled: boolean;
};

export type ZodRecurringTasks = {
  [key: string]: {
    pattern: string;
    options?: CronItemOptions;
    handler: (payload: RecurringTaskPayload, job: GraphileJob) => Promise<void>;
  };
};

export type ZodWorkerEnqueueOptions = TaskSpec & {
  tx?: PrismaClientOrTransaction;
};

export type ZodWorkerDequeueOptions = {
  tx?: PrismaClientOrTransaction;
};

export type ZodWorkerOptions<TMessageCatalog extends MessageCatalogSchema> = {
  name: string;
  runnerOptions: RunnerOptions;
  prisma: PrismaClient;
  schema: TMessageCatalog;
  tasks: ZodTasks<TMessageCatalog>;
  recurringTasks?: ZodRecurringTasks;
};

export class ZodWorker<TMessageCatalog extends MessageCatalogSchema> {
  #name: string;
  #schema: TMessageCatalog;
  #prisma: PrismaClient;
  #runnerOptions: RunnerOptions;
  #tasks: ZodTasks<TMessageCatalog>;
  #recurringTasks?: ZodRecurringTasks;
  #runner?: GraphileRunner;

  constructor(options: ZodWorkerOptions<TMessageCatalog>) {
    this.#name = options.name;
    this.#schema = options.schema;
    this.#prisma = options.prisma;
    this.#runnerOptions = options.runnerOptions;
    this.#tasks = options.tasks;
    this.#recurringTasks = options.recurringTasks;
  }

  public async initialize(): Promise<boolean> {
    if (this.#runner) {
      return true;
    }

    this.#logDebug("Initializing worker queue with options", {
      runnerOptions: this.#runnerOptions,
    });

    const parsedCronItems = parseCronItems(this.#createCronItemsFromRecurringTasks());

    this.#runner = await graphileRun({
      ...this.#runnerOptions,
      taskList: this.#createTaskListFromTasks(),
      parsedCronItems,
    });

    if (!this.#runner) {
      throw new Error("Failed to initialize worker queue");
    }

    this.#runner?.events.on("pool:create", ({ workerPool }) => {
      this.#logDebug("pool:create");
    });

    this.#runner?.events.on("pool:listen:connecting", ({ workerPool, attempts }) => {
      this.#logDebug("pool:create", { attempts });
    });

    this.#runner?.events.on("pool:listen:success", ({ workerPool, client }) => {
      this.#logDebug("pool:listen:success");
    });

    this.#runner?.events.on("pool:listen:error", ({ error }) => {
      this.#logDebug("pool:listen:error", { error });
    });

    this.#runner?.events.on("pool:gracefulShutdown", ({ message }) => {
      this.#logDebug("pool:gracefulShutdown", { workerMessage: message });
    });

    this.#runner?.events.on("pool:gracefulShutdown:error", ({ error }) => {
      this.#logDebug("pool:gracefulShutdown:error", { error });
    });

    this.#runner?.events.on("worker:create", ({ worker }) => {
      this.#logDebug("worker:create", { workerId: worker.workerId });
    });

    this.#runner?.events.on("worker:release", ({ worker }) => {
      this.#logDebug("worker:release", { workerId: worker.workerId });
    });

    this.#runner?.events.on("worker:stop", ({ worker, error }) => {
      this.#logDebug("worker:stop", { workerId: worker.workerId, error });
    });

    this.#runner?.events.on("worker:fatalError", ({ worker, error, jobError }) => {
      this.#logDebug("worker:fatalError", { workerId: worker.workerId, error, jobError });
    });

    this.#runner?.events.on("gracefulShutdown", ({ signal }) => {
      this.#logDebug("gracefulShutdown", { signal });
    });

    this.#runner?.events.on("stop", () => {
      this.#logDebug("stop");
    });

    return true;
  }

  #logDebug(message: string, args?: any) {
    logger.debug(`[worker][${this.#name}] ${message}`, args);
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
    const taskWithoutJobKey = omit(task, ["jobKey"]);

    const spec = {
      ...optionsWithoutTx,
      ...taskWithoutJobKey,
    };

    if (typeof task.queueName === "function") {
      spec.queueName = task.queueName(payload);
    }

    if (typeof task.jobKey === "function") {
      const jobKey = task.jobKey(payload);

      if (jobKey) {
        spec.jobKey = jobKey;
      }
    }

    logger.debug("Enqueuing worker task", {
      identifier,
      payload,
      spec,
    });

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

  public async dequeue(jobKey: string, option?: ZodWorkerDequeueOptions): Promise<GraphileJob> {
    if (!this.#runner) {
      throw new Error("Worker not initialized");
    }

    const job = await this.#removeJob(jobKey, option?.tx ?? this.#prisma);

    logger.debug("dequeued worker task", { job });

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
      spec.flags || null,
      spec.jobKeyMode || null
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

  async #removeJob(jobKey: string, tx: PrismaClientOrTransaction) {
    try {
      const result = await tx.$queryRawUnsafe(
        `SELECT * FROM graphile_worker.remove_job(
          job_key => $1::text
        )`,
        jobKey
      );
      const job = AddJobResultsSchema.safeParse(result);

      if (!job.success) {
        throw new Error(
          `Failed to remove job from queue, zod parsing error: ${JSON.stringify(job.error)}`
        );
      }

      return job.data[0] as GraphileJob;
    } catch (e) {
      throw new Error(`Failed to remove job from queue, ${e}}`);
    }
  }

  #createTaskListFromTasks() {
    const taskList: TaskList = {};

    for (const [key] of Object.entries(this.#tasks)) {
      const task: Task = (payload, helpers) => {
        return this.#handleMessage(key, payload, helpers);
      };

      taskList[key] = task;
    }

    for (const [key] of Object.entries(this.#recurringTasks ?? {})) {
      const task: Task = (payload, helpers) => {
        return this.#handleRecurringTask(key, payload, helpers);
      };

      taskList[key] = task;
    }

    return taskList;
  }

  #createCronItemsFromRecurringTasks() {
    const cronItems: CronItem[] = [];

    if (!this.#recurringTasks) {
      return cronItems;
    }

    for (const [key, task] of Object.entries(this.#recurringTasks)) {
      const cronItem: CronItem = {
        pattern: task.pattern,
        identifier: key,
        task: key,
        options: task.options,
      };

      cronItems.push(cronItem);
    }

    return cronItems;
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

  async #handleRecurringTask(
    typeName: string,
    rawPayload: unknown,
    helpers: JobHelpers
  ): Promise<void> {
    const job = helpers.job;

    logger.debug("Received recurring task, calling handler", {
      type: String(typeName),
      payload: rawPayload,
      job,
    });

    const recurringTask = this.#recurringTasks?.[typeName];

    if (!recurringTask) {
      throw new Error(`No recurring task for message type: ${String(typeName)}`);
    }

    const parsedPayload = RawCronPayloadSchema.safeParse(rawPayload);

    if (!parsedPayload.success) {
      throw new Error(
        `Failed to parse recurring task payload: ${JSON.stringify(parsedPayload.error)}`
      );
    }

    const payload = parsedPayload.data;

    try {
      await recurringTask.handler(payload._cron, job);
    } catch (error) {
      logger.error("Failed to handle recurring task", {
        error,
        payload,
      });

      throw error;
    }
  }
}
