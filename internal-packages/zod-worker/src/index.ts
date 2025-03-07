import { SpanKind, SpanStatusCode, trace } from "@internal/tracing";
import { flattenAttributes } from "@trigger.dev/core/v3";
import type {
  CronItem,
  CronItemOptions,
  DbJob as GraphileJob,
  Runner as GraphileRunner,
  JobHelpers,
  RunnerOptions,
  Task,
  TaskList,
  TaskSpec,
  WorkerUtils,
} from "graphile-worker";
import {
  Logger as GraphileLogger,
  run as graphileRun,
  makeWorkerUtils,
  parseCronItems,
} from "graphile-worker";
import omit from "lodash.omit";
import { z } from "zod";
import { Logger } from "@trigger.dev/core/logger";
import {
  PrismaClient,
  PrismaClientOrTransaction,
  PrismaReplicaClient,
} from "@trigger.dev/database";
import { PgListenService } from "./pgListen.server";

export type { RunnerOptions };

const tracer = trace.getTracer("zodWorker", "3.0.0.dp.1");

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
  job_queue_id: z.number().nullable(),
  task_id: z.number(),
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
    jobKey?: string | ((payload: z.infer<TConsumerSchema[K]>) => string | undefined);
    priority?: number;
    maxAttempts?: number;
    jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
    flags?: string[];
    handler: (
      payload: z.infer<TConsumerSchema[K]>,
      job: GraphileJob,
      helpers: JobHelpers
    ) => Promise<void>;
  };
};

type RecurringTaskPayload = {
  ts: Date;
  backfilled: boolean;
};

export type ZodRecurringTasks = {
  [key: string]: {
    match: string;
    options?: CronItemOptions;
    handler: (
      payload: RecurringTaskPayload,
      job: GraphileJob,
      helpers: JobHelpers
    ) => Promise<void>;
  };
};

type ZodTaskSpec = Omit<TaskSpec, "queueName">;

export type ZodWorkerEnqueueOptions = ZodTaskSpec & {
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

export interface ZodWorkerRateLimiter {
  forbiddenFlags(): Promise<string[]>;
  wrapTask(t: Task, rescheduler: Task): Task;
}

export type ZodWorkerOptions<TMessageCatalog extends MessageCatalogSchema> = {
  name: string;
  runnerOptions: RunnerOptions;
  prisma: PrismaClient;
  replica: PrismaReplicaClient;
  schema: TMessageCatalog;
  tasks: ZodTasks<TMessageCatalog>;
  recurringTasks?: ZodRecurringTasks;
  cleanup?: ZodWorkerCleanupOptions;
  reporter?: ZodWorkerReporter;
  shutdownTimeoutInMs?: number;
  rateLimiter?: ZodWorkerRateLimiter;
  verboseLogging?: boolean;
  logger: Logger;
};

export class ZodWorker<TMessageCatalog extends MessageCatalogSchema> {
  #name: string;
  #schema: TMessageCatalog;
  #prisma: PrismaClient;
  #replica: PrismaReplicaClient;
  #runnerOptions: RunnerOptions;
  #tasks: ZodTasks<TMessageCatalog>;
  #recurringTasks?: ZodRecurringTasks;
  #runner?: GraphileRunner;
  #cleanup: ZodWorkerCleanupOptions | undefined;
  #reporter?: ZodWorkerReporter;
  #rateLimiter?: ZodWorkerRateLimiter;
  #shutdownTimeoutInMs?: number;
  #shuttingDown = false;
  #workerUtils?: WorkerUtils;
  #verboseLogging?: boolean;
  #logger: Logger;

  constructor(options: ZodWorkerOptions<TMessageCatalog>) {
    this.#name = options.name;
    this.#schema = options.schema;
    this.#prisma = options.prisma;
    this.#replica = options.replica;
    this.#runnerOptions = options.runnerOptions;
    this.#tasks = options.tasks;
    this.#recurringTasks = options.recurringTasks;
    this.#cleanup = options.cleanup;
    this.#reporter = options.reporter;
    this.#rateLimiter = options.rateLimiter;
    this.#shutdownTimeoutInMs = options.shutdownTimeoutInMs ?? 60000; // default to 60 seconds
    this.#verboseLogging = options.verboseLogging;
    this.#logger = options.logger;
  }

  get graphileWorkerSchema() {
    return this.#runnerOptions.schema ?? "graphile_worker";
  }

  public async initialize(): Promise<boolean> {
    if (this.#runner) {
      return true;
    }

    this.#logDebug("Initializing graphile worker queue with options", {
      runnerOptions: this.#runnerOptions,
    });

    const parsedCronItems = parseCronItems(this.#createCronItemsFromRecurringTasks());

    this.#workerUtils = await makeWorkerUtils(this.#runnerOptions);

    const graphileLogger = new GraphileLogger((scope) => {
      return (level, message, meta) => {
        if (this.#verboseLogging !== true) return;

        this.#logger.debug(`[graphile-worker][${this.#name}][${level}] ${message}`, {
          scope,
          meta,
          workerName: this.#name,
        });
      };
    });

    this.#runner = await graphileRun({
      ...this.#runnerOptions,
      noHandleSignals: true,
      taskList: this.#createTaskListFromTasks(),
      parsedCronItems,
      forbiddenFlags: this.#rateLimiter?.forbiddenFlags.bind(this.#rateLimiter),
      logger: graphileLogger,
    });

    if (!this.#runner) {
      throw new Error("Failed to initialize graphile worker queue");
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
      const pgListen = new PgListenService(client, this.#logger, this.#name);

      await pgListen.on("trigger:graphile:migrate", async ({ latestMigration }) => {
        this.#logDebug("Detected incoming migration", { latestMigration });

        if (latestMigration > 10) {
          this.#logDebug("Already migrated past v0.14 - nothing to do", { latestMigration });
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

    this.#runner?.events.on("worker:getJob:error", ({ worker, error }) => {
      this.#logDebug("worker:getJob:error", { workerId: worker.workerId, error });
    });

    this.#runner?.events.on("worker:getJob:start", ({ worker }) => {
      if (this.#verboseLogging !== true) return;
      this.#logDebug("worker:getJob:start", { workerId: worker.workerId });
    });

    this.#runner?.events.on("job:start", ({ worker, job }) => {
      if (this.#verboseLogging !== true) return;
      this.#logDebug("job:start", { workerId: worker.workerId, job });
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

    this.#logDebug(
      `Received ${signal}, shutting down zodWorker with timeout ${this.#shutdownTimeoutInMs}ms`
    );

    if (this.#shutdownTimeoutInMs) {
      setTimeout(() => {
        this.#logDebug(`Shutdown timeout of ${this.#shutdownTimeoutInMs} reached, exiting process`);

        process.exit(0);
      }, this.#shutdownTimeoutInMs);
    }

    this.stop().finally(() => {
      this.#logDebug("zodWorker stopped");
    });
  }

  public async stop() {
    await this.#runner?.stop();
    await this.#workerUtils?.release();
  }

  public async enqueue<K extends keyof TMessageCatalog>(
    identifier: K,
    payload: z.infer<TMessageCatalog[K]>,
    options?: ZodWorkerEnqueueOptions
  ): Promise<GraphileJob | undefined> {
    const task = this.#tasks[identifier];

    const optionsWithoutTx = removeUndefinedKeys(omit(options ?? {}, ["tx"]));
    const taskWithoutJobKey = omit(task, ["jobKey"]);

    // Make sure options passed in to enqueue take precedence over task options
    const spec = {
      ...taskWithoutJobKey,
      ...optionsWithoutTx,
    };

    if (typeof task.jobKey === "function") {
      const jobKey = task.jobKey(payload);

      if (jobKey) {
        spec.jobKey = jobKey;
      }
    }

    const { job, durationInMs } = await tracer.startActiveSpan(
      `Enqueue ${identifier as string}`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          "job.task_identifier": identifier as string,
          "job.payload": payload,
          "job.priority": spec.priority,
          "job.run_at": spec.runAt?.toISOString(),
          "job.jobKey": spec.jobKey,
          "job.flags": spec.flags,
          "job.max_attempts": spec.maxAttempts,
          "worker.name": this.#name,
        },
      },
      async (span) => {
        try {
          const results = await this.#addJob(
            identifier as string,
            payload,
            spec,
            options?.tx ?? this.#prisma
          );

          return results;
        } catch (error) {
          if (error instanceof Error) {
            span.recordException(error);
          } else {
            span.recordException(new Error(String(error)));
          }

          span.setStatus({ code: SpanStatusCode.ERROR });

          throw error;
        } finally {
          span.end();
        }
      }
    );

    this.#logger.debug("Enqueued worker task", {
      identifier,
      payload,
      spec,
      job,
      durationInMs,
    });

    return job;
  }

  public async dequeue(
    jobKey: string,
    option?: ZodWorkerDequeueOptions
  ): Promise<GraphileJob | undefined> {
    const results = await this.#removeJob(jobKey, option?.tx ?? this.#prisma);

    this.#logger.debug("dequeued worker task", { results, jobKey });

    return results;
  }

  async #addJob(
    identifier: string,
    payload: unknown,
    spec: TaskSpec,
    tx: PrismaClientOrTransaction
  ) {
    const now = performance.now();

    const results = await tx.$queryRawUnsafe(
      `SELECT * FROM ${this.graphileWorkerSchema}.add_job(
          identifier => $1::text,
          payload => $2::json,
          run_at => $3::timestamptz,
          max_attempts => $4::int,
          job_key => $5::text,
          priority => $6::int,
          flags => $7::text[],
          job_key_mode => $8::text
        )`,
      identifier,
      JSON.stringify(payload),
      spec.runAt || null,
      spec.maxAttempts || null,
      spec.jobKey || null,
      spec.priority || null,
      spec.flags || null,
      spec.jobKeyMode || null
    );

    const durationInMs = performance.now() - now;

    const rows = AddJobResultsSchema.safeParse(results);

    if (!rows.success) {
      this.#logger.debug("results returned from add_job could not be parsed", {
        identifier,
        payload,
        spec,
        error: JSON.stringify(rows.error),
      });
      return { job: undefined, durationInMs: Math.floor(durationInMs) };
    }

    const job = rows.data[0];

    return { job: job as GraphileJob, durationInMs: Math.floor(durationInMs) };
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
        this.#logger.debug("could not remove job, job_key did not exist", {
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

      if (this.#rateLimiter) {
        taskList[key] = this.#rateLimiter.wrapTask(task, this.#rescheduleTask.bind(this));
      } else {
        taskList[key] = task;
      }
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

  async #rescheduleTask(payload: unknown, helpers: JobHelpers) {
    this.#logDebug("Rescheduling task", { payload, job: helpers.job });

    await this.enqueue(helpers.job.task_identifier, payload, {
      runAt: helpers.job.run_at,
      priority: helpers.job.priority,
      jobKey: helpers.job.key ?? undefined,
      flags: Object.keys(helpers.job.flags ?? []),
      maxAttempts: helpers.job.max_attempts - (helpers.job.attempts - 1),
    });
  }

  #createCronItemsFromRecurringTasks() {
    const cronItems: CronItem[] = [];

    if (this.#cleanup) {
      cronItems.push({
        match: this.#cleanup.frequencyExpression,
        identifier: CLEANUP_TASK_NAME,
        task: CLEANUP_TASK_NAME,
        options: this.#cleanup.taskOptions,
      });
    }

    if (this.#reporter) {
      cronItems.push({
        match: "50 * * * *", // Every hour at 50 minutes past the hour
        identifier: REPORTER_TASK_NAME,
        task: REPORTER_TASK_NAME,
      });
    }

    if (!this.#recurringTasks) {
      return cronItems;
    }

    for (const [key, task] of Object.entries(this.#recurringTasks)) {
      const cronItem: CronItem = {
        match: task.match,
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

    this.#logger.debug("Received worker task, calling handler", {
      type: String(typeName),
      payload,
      job,
    });

    const task = this.#tasks[typeName];

    if (!task) {
      throw new Error(`No task for message type: ${String(typeName)}`);
    }

    await tracer.startActiveSpan(
      `Run ${typeName as string}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          "job.task_identifier": job.task_identifier,
          "job.id": job.id,
          ...(job.job_queue_id ? { "job.queue_id": job.job_queue_id } : {}),
          ...flattenAttributes(job.payload as Record<string, unknown>, "job.payload"),
          "job.priority": job.priority,
          "job.run_at": job.run_at.toISOString(),
          "job.attempts": job.attempts,
          "job.max_attempts": job.max_attempts,
          "job.created_at": job.created_at.toISOString(),
          "job.updated_at": job.updated_at.toISOString(),
          ...(job.key ? { "job.key": job.key } : {}),
          "job.revision": job.revision,
          ...(job.locked_at ? { "job.locked_at": job.locked_at.toISOString() } : {}),
          ...(job.locked_by ? { "job.locked_by": job.locked_by } : {}),
          ...(job.flags ? flattenAttributes(job.flags, "job.flags") : {}),
          "worker.name": this.#name,
        },
      },
      async (span) => {
        try {
          await task.handler(payload, job, helpers);
        } catch (error) {
          if (error instanceof Error) {
            span.recordException(error);
          } else {
            span.recordException(new Error(String(error)));
          }

          if (job.attempts >= job.max_attempts) {
            this.#logger.debug("Job failed after max attempts", {
              job,
              attempts: job.attempts,
              max_attempts: job.max_attempts,
              error: error instanceof Error ? error.message : error,
            });

            return;
          }

          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  async #handleRecurringTask(
    typeName: string,
    rawPayload: unknown,
    helpers: JobHelpers
  ): Promise<void> {
    const job = helpers.job;

    this.#logger.debug("Received recurring task, calling handler", {
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

    await tracer.startActiveSpan(
      `Run ${typeName as string} recurring`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          "job.task_identifier": job.task_identifier,
          "job.id": job.id,
          ...(job.job_queue_id ? { "job.queue_id": job.job_queue_id } : {}),
          ...flattenAttributes(job.payload as Record<string, unknown>, "job.payload"),
          "job.priority": job.priority,
          "job.run_at": job.run_at.toISOString(),
          "job.attempts": job.attempts,
          "job.max_attempts": job.max_attempts,
          "job.created_at": job.created_at.toISOString(),
          "job.updated_at": job.updated_at.toISOString(),
          ...(job.key ? { "job.key": job.key } : {}),
          "job.revision": job.revision,
          ...(job.locked_at ? { "job.locked_at": job.locked_at.toISOString() } : {}),
          ...(job.locked_by ? { "job.locked_by": job.locked_by } : {}),
          ...(job.flags ? flattenAttributes(job.flags, "job.flags") : {}),
          "worker.name": this.#name,
        },
      },
      async (span) => {
        try {
          await recurringTask.handler(payload._cron, job, helpers);
        } catch (error) {
          if (error instanceof Error) {
            span.recordException(error);
          } else {
            span.recordException(new Error(String(error)));
          }

          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  async #handleCleanup(rawPayload: unknown, helpers: JobHelpers): Promise<void> {
    if (!this.#cleanup) {
      return;
    }

    if (!this.#workerUtils) {
      throw new Error("WorkerUtils need to be initialized before running job cleanup.");
    }

    const job = helpers.job;

    this.#logger.debug("Received cleanup task", {
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

    this.#logger.debug("Cleaning up old jobs", {
      expirationDate,
      payload,
    });

    const rawResults = await this.#replica.$queryRawUnsafe(
      `SELECT id
        FROM ${this.graphileWorkerSchema}.jobs
        WHERE run_at < $1
          AND locked_at IS NULL
          AND max_attempts = attempts
        LIMIT $2`,
      expirationDate,
      this.#cleanup.maxCount
    );

    const results = z
      .array(
        z.object({
          id: z.coerce.string(),
        })
      )
      .parse(rawResults);

    const completedJobs = await this.#workerUtils.completeJobs(results.map((job) => job.id));

    this.#logger.debug("Cleaned up old jobs", {
      found: results.length,
      deleted: completedJobs.length,
      expirationDate,
      payload,
    });

    if (this.#reporter) {
      await this.#reporter("cleanup_stats", {
        found: results.length,
        deleted: completedJobs.length,
        expirationDate,
        ts: payload._cron.ts,
      });
    }
  }

  async #handleReporter(rawPayload: unknown, helpers: JobHelpers): Promise<void> {
    if (!this.#reporter) {
      return;
    }

    this.#logger.debug("Received reporter task", {
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
    const rawAddedResults = await this.#replica.$queryRawUnsafe(
      `SELECT COUNT(*) FROM ${this.graphileWorkerSchema}.jobs WHERE created_at > $1 AND created_at < $2`,
      startAt,
      payload._cron.ts
    );

    const addedCountResults = schema.parse(rawAddedResults)[0];

    // Count the total number of jobs in the jobs table
    const rawTotalResults = await this.#replica.$queryRawUnsafe(
      `SELECT COUNT(*) FROM ${this.graphileWorkerSchema}.jobs`
    );

    const totalCountResults = schema.parse(rawTotalResults)[0];

    this.#logger.debug("Calculated metrics about the jobs table", {
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
    this.#logger.debug(`[worker][${this.#name}] ${message}`, args);
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
