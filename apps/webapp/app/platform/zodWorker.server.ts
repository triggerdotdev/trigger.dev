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
import { workerLogger as logger } from "~/services/logger.server";
import { PgListenService } from "~/services/db/pgListen.server";
import { safeJsonParse } from "~/utils/json";

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

const CLEANUP_TASK_NAME = "__cleanupOldJobs";
const REPORTER_TASK_NAME = "__reporter";

export type ZodWorkerCleanupOptions = {
  frequencyExpression: string; // cron expression
  ttl: number;
  maxCount: number;
  taskOptions?: CronItemOptions;
};

type ZodWorkerReporter = (event: string, properties: Record<string, any>) => Promise<void>;

export type ZodWorkerOptions<TMessageCatalog extends MessageCatalogSchema> = {
  name: string;
  runnerOptions: RunnerOptions;
  prisma: PrismaClient;
  schema: TMessageCatalog;
  tasks: ZodTasks<TMessageCatalog>;
  recurringTasks?: ZodRecurringTasks;
  cleanup?: ZodWorkerCleanupOptions;
  reporter?: ZodWorkerReporter;
  shutdownTimeoutInMs?: number;
};

export class ZodWorker<TMessageCatalog extends MessageCatalogSchema> {
  #name: string;
  #schema: TMessageCatalog;
  #prisma: PrismaClient;
  #runnerOptions: RunnerOptions;
  #tasks: ZodTasks<TMessageCatalog>;
  #recurringTasks?: ZodRecurringTasks;
  #runner?: GraphileRunner;
  #cleanup: ZodWorkerCleanupOptions | undefined;
  #reporter?: ZodWorkerReporter;
  #shutdownTimeoutInMs?: number;
  #shuttingDown = false;

  constructor(options: ZodWorkerOptions<TMessageCatalog>) {
    this.#name = options.name;
    this.#schema = options.schema;
    this.#prisma = options.prisma;
    this.#runnerOptions = options.runnerOptions;
    this.#tasks = options.tasks;
    this.#recurringTasks = options.recurringTasks;
    this.#cleanup = options.cleanup;
    this.#reporter = options.reporter;
    this.#shutdownTimeoutInMs = options.shutdownTimeoutInMs ?? 60000; // default to 60 seconds
  }

  get graphileWorkerSchema() {
    return this.#runnerOptions.schema ?? "graphile_worker";
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
      noHandleSignals: true,
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

    this.#runner?.events.on("pool:listen:success", async ({ workerPool, client }) => {
      this.#logDebug("pool:listen:success");

      // hijack client instance to listen and react to incoming NOTIFY events
      const pgListen = new PgListenService(client, this.#name, logger);

      await pgListen.call("trigger:graphile:migrate", async (payload) => {
        const parsedPayload = safeJsonParse(payload);

        const MigrationNotificationPayloadSchema = z.object({
          latestMigration: z.number(),
        });

        const { latestMigration } = MigrationNotificationPayloadSchema.parse(parsedPayload);

        this.#logDebug("Detected incoming migration", { latestMigration });

        if (latestMigration > 10) {
          // already migrated past v0.14 - nothing to do
          return;
        }

        // simulate SIGTERM to trigger graceful shutdown
        this._handleSignal("SIGTERM");
      });
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

    process.on("SIGTERM", this._handleSignal.bind(this));
    process.on("SIGINT", this._handleSignal.bind(this));

    return true;
  }

  private _handleSignal(signal: string) {
    if (this.#shuttingDown) {
      return;
    }

    this.#shuttingDown = true;

    if (this.#shutdownTimeoutInMs) {
      setTimeout(() => {
        this.#logDebug("Shutdown timeout reached, exiting process");

        process.exit(0);
      }, this.#shutdownTimeoutInMs);
    }

    this.#logDebug(`Received ${signal}, shutting down zodWorker...`);

    this.stop().finally(() => {
      this.#logDebug("zodWorker stopped");
    });
  }

  public async stop() {
    await this.#runner?.stop();
  }

  public async enqueue<K extends keyof TMessageCatalog>(
    identifier: K,
    payload: z.infer<TMessageCatalog[K]>,
    options?: ZodWorkerEnqueueOptions
  ): Promise<GraphileJob> {
    const task = this.#tasks[identifier];

    const optionsWithoutTx = removeUndefinedKeys(omit(options ?? {}, ["tx"]));
    const taskWithoutJobKey = omit(task, ["jobKey"]);

    // Make sure options passed in to enqueue take precedence over task options
    const spec = {
      ...taskWithoutJobKey,
      ...optionsWithoutTx,
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

  public async dequeue(
    jobKey: string,
    option?: ZodWorkerDequeueOptions
  ): Promise<GraphileJob | undefined> {
    const results = await this.#removeJob(jobKey, option?.tx ?? this.#prisma);

    logger.debug("dequeued worker task", { results, jobKey });

    return results;
  }

  async #addJob(
    identifier: string,
    payload: unknown,
    spec: TaskSpec,
    tx: PrismaClientOrTransaction
  ) {
    const results = await tx.$queryRawUnsafe(
      `SELECT * FROM ${this.graphileWorkerSchema}.add_job(
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
        `SELECT * FROM ${this.graphileWorkerSchema}.remove_job(
          job_key => $1::text
        )`,
        jobKey
      );
      const job = AddJobResultsSchema.safeParse(result);

      if (!job.success) {
        logger.debug("results returned from remove_job could not be parsed", {
          error: job.error.flatten(),
          result,
          jobKey,
        });

        return;
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

    if (this.#cleanup) {
      const task: Task = (payload, helpers) => {
        return this.#handleCleanup(payload, helpers);
      };

      taskList[CLEANUP_TASK_NAME] = task;
    }

    if (this.#reporter) {
      const task: Task = (payload, helpers) => {
        return this.#handleReporter(payload, helpers);
      };

      taskList[REPORTER_TASK_NAME] = task;
    }

    return taskList;
  }

  #createCronItemsFromRecurringTasks() {
    const cronItems: CronItem[] = [];

    if (this.#cleanup) {
      cronItems.push({
        pattern: this.#cleanup.frequencyExpression,
        identifier: CLEANUP_TASK_NAME,
        task: CLEANUP_TASK_NAME,
        options: this.#cleanup.taskOptions,
      });
    }

    if (this.#reporter) {
      cronItems.push({
        pattern: "50 * * * *", // Every hour at 50 minutes past the hour
        identifier: REPORTER_TASK_NAME,
        task: REPORTER_TASK_NAME,
      });
    }

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

  async #handleCleanup(rawPayload: unknown, helpers: JobHelpers): Promise<void> {
    if (!this.#cleanup) {
      return;
    }

    const job = helpers.job;

    logger.debug("Received cleanup task", {
      payload: rawPayload,
      job,
    });

    const parsedPayload = RawCronPayloadSchema.safeParse(rawPayload);

    if (!parsedPayload.success) {
      throw new Error(
        `Failed to parse cleanup task payload: ${JSON.stringify(parsedPayload.error)}`
      );
    }

    const payload = parsedPayload.data;

    // Add the this.#cleanup.ttl to the payload._cron.ts
    const expirationDate = new Date(payload._cron.ts.getTime() - this.#cleanup.ttl);

    logger.debug("Cleaning up old jobs", {
      expirationDate,
      payload,
    });

    const rawResults = await this.#prisma.$queryRawUnsafe(
      `WITH rows AS (SELECT id FROM ${this.graphileWorkerSchema}.jobs WHERE run_at < $1 AND locked_at IS NULL AND max_attempts = attempts LIMIT $2 FOR UPDATE) DELETE FROM ${this.graphileWorkerSchema}.jobs WHERE id IN (SELECT id FROM rows) RETURNING id`,
      expirationDate,
      this.#cleanup.maxCount
    );

    const results = Array.isArray(rawResults) ? rawResults : [];

    logger.debug("Cleaned up old jobs", {
      count: results.length,
      expirationDate,
      payload,
    });

    if (this.#reporter) {
      await this.#reporter("cleanup_stats", {
        count: results.length,
        expirationDate,
        ts: payload._cron.ts,
      });
    }
  }

  async #handleReporter(rawPayload: unknown, helpers: JobHelpers): Promise<void> {
    if (!this.#reporter) {
      return;
    }

    logger.debug("Received reporter task", {
      payload: rawPayload,
    });

    const parsedPayload = RawCronPayloadSchema.safeParse(rawPayload);

    if (!parsedPayload.success) {
      throw new Error(
        `Failed to parse cleanup task payload: ${JSON.stringify(parsedPayload.error)}`
      );
    }

    const payload = parsedPayload.data;

    // Subtract an hour from the payload._cron.ts
    const startAt = new Date(payload._cron.ts.getTime() - 1000 * 60 * 60);

    const schema = z.array(z.object({ count: z.coerce.number() }));

    // Count the number of jobs that have been added since the startAt date and before the payload._cron.ts date
    const rawAddedResults = await this.#prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM ${this.graphileWorkerSchema}.jobs WHERE created_at > $1 AND created_at < $2`,
      startAt,
      payload._cron.ts
    );

    const addedCountResults = schema.parse(rawAddedResults)[0];

    // Count the total number of jobs in the jobs table
    const rawTotalResults = await this.#prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM ${this.graphileWorkerSchema}.jobs`
    );

    const totalCountResults = schema.parse(rawTotalResults)[0];

    logger.debug("Calculated metrics about the jobs table", {
      rawAddedResults,
      rawTotalResults,
      payload,
    });

    await this.#reporter("queue_metrics", {
      addedCount: addedCountResults.count,
      totalCount: totalCountResults.count,
      ts: payload._cron.ts,
    });
  }

  #logDebug(message: string, args?: any) {
    logger.debug(`[worker][${this.#name}] ${message}`, args);
  }
}

function removeUndefinedKeys<T extends object>(obj: T): T {
  for (let key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] === undefined) {
      delete obj[key];
    }
  }
  return obj;
}
