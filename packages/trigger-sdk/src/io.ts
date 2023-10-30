import {
  API_VERSIONS,
  BloomFilter,
  CachedTask,
  ConnectionAuth,
  CronOptions,
  ErrorWithStackSchema,
  FetchRequestInit,
  FetchRetryOptions,
  InitialStatusUpdate,
  IntervalOptions,
  LogLevel,
  Logger,
  RunTaskOptions,
  SendEvent,
  SendEventOptions,
  SerializableJsonSchema,
  ServerTask,
  UpdateTriggerSourceBodyV2,
  supportsFeature,
} from "@trigger.dev/core";
import { AsyncLocalStorage } from "node:async_hooks";
import { webcrypto } from "node:crypto";
import { ApiClient } from "./apiClient";
import {
  AutoYieldExecutionError,
  AutoYieldWithCompletedTaskExecutionError,
  CanceledWithTaskError,
  ResumeWithTaskError,
  RetryWithTaskError,
  YieldExecutionError,
  isTriggerError,
} from "./errors";
import { calculateRetryAt } from "./retry";
import { TriggerClient } from "./triggerClient";
import { DynamicTrigger } from "./triggers/dynamic";
import { ExternalSource, ExternalSourceParams } from "./triggers/externalSource";
import { DynamicSchedule } from "./triggers/scheduled";
import { EventSpecification, TaskLogger, TriggerContext } from "./types";
import { IntegrationTaskKey } from "./integrations";
import { TriggerStatus } from "./status";

export type IOTask = ServerTask;

export type IOOptions = {
  id: string;
  apiClient: ApiClient;
  client: TriggerClient;
  context: TriggerContext;
  timeOrigin: number;
  logger?: Logger;
  logLevel?: LogLevel;
  jobLogger?: Logger;
  jobLogLevel: LogLevel;
  cachedTasks?: Array<CachedTask>;
  cachedTasksCursor?: string;
  yieldedExecutions?: Array<string>;
  noopTasksSet?: string;
  serverVersion?: string | null;
  executionTimeout?: number;
};

type JsonPrimitive = string | number | boolean | null | undefined | Date | symbol;
type JsonArray = Json[];
type JsonRecord<T> = { [Property in keyof T]: Json };
export type Json<T = any> = JsonPrimitive | JsonArray | JsonRecord<T>;

export type RunTaskErrorCallback = (
  error: unknown,
  task: IOTask,
  io: IO
) =>
  | { retryAt?: Date; error?: Error; jitter?: number; skipRetrying?: boolean }
  | Error
  | undefined
  | void;

export type IOStats = {
  initialCachedTasks: number;
  lazyLoadedCachedTasks: number;
  executedTasks: number;
  cachedTaskHits: number;
  cachedTaskMisses: number;
  noopCachedTaskHits: number;
  noopCachedTaskMisses: number;
};

export class IO {
  private _id: string;
  private _apiClient: ApiClient;
  private _triggerClient: TriggerClient;
  private _logger: Logger;
  private _jobLogger?: Logger;
  private _jobLogLevel: LogLevel;
  private _cachedTasks: Map<string, CachedTask>;
  private _taskStorage: AsyncLocalStorage<{ taskId: string }>;
  private _cachedTasksCursor?: string;
  private _context: TriggerContext;
  private _yieldedExecutions: Array<string>;
  private _noopTasksBloomFilter: BloomFilter | undefined;
  private _stats: IOStats;
  private _serverVersion: string;
  private _timeOrigin: number;
  private _executionTimeout?: number;

  get stats() {
    return this._stats;
  }

  constructor(options: IOOptions) {
    this._id = options.id;
    this._apiClient = options.apiClient;
    this._triggerClient = options.client;
    this._logger = options.logger ?? new Logger("trigger.dev", options.logLevel);
    this._cachedTasks = new Map();
    this._jobLogger = options.jobLogger;
    this._jobLogLevel = options.jobLogLevel;
    this._timeOrigin = options.timeOrigin;
    this._executionTimeout = options.executionTimeout;

    this._stats = {
      initialCachedTasks: 0,
      lazyLoadedCachedTasks: 0,
      executedTasks: 0,
      cachedTaskHits: 0,
      cachedTaskMisses: 0,
      noopCachedTaskHits: 0,
      noopCachedTaskMisses: 0,
    };

    if (options.cachedTasks) {
      options.cachedTasks.forEach((task) => {
        this._cachedTasks.set(task.idempotencyKey, task);
      });

      this._stats.initialCachedTasks = options.cachedTasks.length;
    }

    this._taskStorage = new AsyncLocalStorage();
    this._context = options.context;
    this._yieldedExecutions = options.yieldedExecutions ?? [];

    if (options.noopTasksSet) {
      this._noopTasksBloomFilter = BloomFilter.deserialize(
        options.noopTasksSet,
        BloomFilter.NOOP_TASK_SET_SIZE
      );
    }

    this._cachedTasksCursor = options.cachedTasksCursor;
    this._serverVersion = options.serverVersion ?? "unversioned";
  }

  /** @internal */
  get runId() {
    return this._id;
  }

  /** @internal */
  get triggerClient() {
    return this._triggerClient;
  }

  /** Used to send log messages to the [Run log](https://trigger.dev/docs/documentation/guides/viewing-runs). */
  get logger() {
    return new IOLogger(async (level, message, data) => {
      let logLevel: LogLevel = "info";

      if (Logger.satisfiesLogLevel(logLevel, this._jobLogLevel)) {
        await this.runTask(
          [message, level],
          async (task) => {
            switch (level) {
              case "LOG": {
                this._jobLogger?.log(message, data);
                logLevel = "log";
                break;
              }
              case "DEBUG": {
                this._jobLogger?.debug(message, data);
                logLevel = "debug";
                break;
              }
              case "INFO": {
                this._jobLogger?.info(message, data);
                logLevel = "info";
                break;
              }
              case "WARN": {
                this._jobLogger?.warn(message, data);
                logLevel = "warn";
                break;
              }
              case "ERROR": {
                this._jobLogger?.error(message, data);
                logLevel = "error";
                break;
              }
            }
          },
          {
            name: "log",
            icon: "log",
            description: message,
            params: data,
            properties: [{ label: "Level", text: level }],
            style: { style: "minimal", variant: level.toLowerCase() },
            noop: true,
          }
        );
      }
    });
  }

  /** `io.wait()` waits for the specified amount of time before continuing the Job. Delays work even if you're on a serverless platform with timeouts, or if your server goes down. They utilize [resumability](https://trigger.dev/docs/documentation/concepts/resumability) to ensure that the Run can be resumed after the delay.
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param seconds The number of seconds to wait. This can be very long, serverless timeouts are not an issue.
   */
  async wait(cacheKey: string | any[], seconds: number) {
    return await this.runTask(cacheKey, async (task) => {}, {
      name: "wait",
      icon: "clock",
      params: { seconds },
      noop: true,
      delayUntil: new Date(Date.now() + seconds * 1000),
      style: { style: "minimal" },
    });
  }

  /** `io.createStatus()` allows you to set a status with associated data during the Run. Statuses can be used by your UI using the react package 
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param initialStatus The initial status you want this status to have. You can update it during the rub using the returned object.
   * @returns a TriggerStatus object that you can call `update()` on, to update the status.
   * @example 
   * ```ts
   * client.defineJob(
  //...
    run: async (payload, io, ctx) => {
      const generatingImages = await io.createStatus("generating-images", {
        label: "Generating Images",
        state: "loading",
        data: {
          progress: 0.1,
        },
      });

      //...do stuff

      await generatingImages.update("completed-generation", {
        label: "Generated images",
        state: "success",
        data: {
          progress: 1.0,
          urls: ["http://..."]
        },
      });

    //...
  });
   * ```
  */
  async createStatus(
    cacheKey: IntegrationTaskKey,
    initialStatus: InitialStatusUpdate
  ): Promise<TriggerStatus> {
    const id = typeof cacheKey === "string" ? cacheKey : cacheKey.join("-");
    const status = new TriggerStatus(id, this);
    await status.update(cacheKey, initialStatus);
    return status;
  }

  /** `io.backgroundFetch()` fetches data from a URL that can take longer that the serverless timeout. The actual `fetch` request is performed on the Trigger.dev platform, and the response is sent back to you.
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param url The URL to fetch from.
   * @param requestInit The options for the request
   * @param retry The options for retrying the request if it fails
   * An object where the key is a status code pattern and the value is a retrying strategy.
   * Supported patterns are:
   * - Specific status codes: 429
   * - Ranges: 500-599
   * - Wildcards: 2xx, 3xx, 4xx, 5xx
   */
  async backgroundFetch<TResponseData>(
    cacheKey: string | any[],
    url: string,
    requestInit?: FetchRequestInit,
    retry?: FetchRetryOptions
  ): Promise<TResponseData> {
    const urlObject = new URL(url);

    return (await this.runTask(
      cacheKey,
      async (task) => {
        return task.output;
      },
      {
        name: `fetch ${urlObject.hostname}${urlObject.pathname}`,
        params: { url, requestInit, retry },
        operation: "fetch",
        icon: "background",
        noop: false,
        properties: [
          {
            label: "url",
            text: url,
            url,
          },
          {
            label: "method",
            text: requestInit?.method ?? "GET",
          },
          {
            label: "background",
            text: "true",
          },
        ],
      }
    )) as TResponseData;
  }

  /** `io.sendEvent()` allows you to send an event from inside a Job run. The sent even will trigger any Jobs that are listening for that event (based on the name).
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param event The event to send. The event name must match the name of the event that your Jobs are listening for.
   * @param options Options for sending the event.
   */
  async sendEvent(cacheKey: string | any[], event: SendEvent, options?: SendEventOptions) {
    return await this.runTask(
      cacheKey,
      async (task) => {
        return await this._triggerClient.sendEvent(event, options);
      },
      {
        name: "sendEvent",
        params: { event, options },
        properties: [
          {
            label: "name",
            text: event.name,
          },
          ...(event?.id ? [{ label: "ID", text: event.id }] : []),
        ],
      }
    );
  }

  async getEvent(cacheKey: string | any[], id: string) {
    return await this.runTask(
      cacheKey,
      async (task) => {
        return await this._triggerClient.getEvent(id);
      },
      {
        name: "getEvent",
        params: { id },
        properties: [
          {
            label: "id",
            text: id,
          },
        ],
      }
    );
  }

  /** `io.cancelEvent()` allows you to cancel an event that was previously sent with `io.sendEvent()`. This will prevent any Jobs from running that are listening for that event if the event was sent with a delay
   * @param cacheKey
   * @param eventId
   * @returns
   */
  async cancelEvent(cacheKey: string | any[], eventId: string) {
    return await this.runTask(
      cacheKey,
      async (task) => {
        return await this._triggerClient.cancelEvent(eventId);
      },
      {
        name: "cancelEvent",
        params: {
          eventId,
        },
        properties: [
          {
            label: "id",
            text: eventId,
          },
        ],
      }
    );
  }

  async updateSource(
    cacheKey: string | any[],
    options: { key: string } & UpdateTriggerSourceBodyV2
  ) {
    return this.runTask(
      cacheKey,
      async (task) => {
        return await this._apiClient.updateSource(this._triggerClient.id, options.key, options);
      },
      {
        name: "Update Source",
        description: "Update Source",
        properties: [
          {
            label: "key",
            text: options.key,
          },
        ],
        params: options,
        redact: {
          paths: ["secret"],
        },
      }
    );
  }

  /** `io.registerInterval()` allows you to register a [DynamicSchedule](https://trigger.dev/docs/sdk/dynamicschedule) that will trigger any jobs it's attached to on a regular interval.
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param dynamicSchedule The [DynamicSchedule](https://trigger.dev/docs/sdk/dynamicschedule) to register a new schedule on.
   * @param id A unique id for the interval. This is used to identify and unregister the interval later.
   * @param options The options for the interval.
   * @returns A promise that has information about the interval.
   * @deprecated Use `DynamicSchedule.register` instead.
   */
  async registerInterval(
    cacheKey: string | any[],
    dynamicSchedule: DynamicSchedule,
    id: string,
    options: IntervalOptions
  ) {
    return await this.runTask(
      cacheKey,
      async (task) => {
        return dynamicSchedule.register(id, {
          type: "interval",
          options,
        });
      },
      {
        name: "register-interval",
        properties: [
          { label: "schedule", text: dynamicSchedule.id },
          { label: "id", text: id },
          { label: "seconds", text: options.seconds.toString() },
        ],
        params: options,
      }
    );
  }

  /** `io.unregisterInterval()` allows you to unregister a [DynamicSchedule](https://trigger.dev/docs/sdk/dynamicschedule) that was previously registered with `io.registerInterval()`.
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param dynamicSchedule The [DynamicSchedule](https://trigger.dev/docs/sdk/dynamicschedule) to unregister a schedule on.
   * @param id A unique id for the interval. This is used to identify and unregister the interval later.
   * @deprecated Use `DynamicSchedule.unregister` instead.
   */
  async unregisterInterval(cacheKey: string | any[], dynamicSchedule: DynamicSchedule, id: string) {
    return await this.runTask(
      cacheKey,
      async (task) => {
        return dynamicSchedule.unregister(id);
      },
      {
        name: "unregister-interval",
        properties: [
          { label: "schedule", text: dynamicSchedule.id },
          { label: "id", text: id },
        ],
      }
    );
  }

  /** `io.registerCron()` allows you to register a [DynamicSchedule](https://trigger.dev/docs/sdk/dynamicschedule) that will trigger any jobs it's attached to on a regular CRON schedule.
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param dynamicSchedule The [DynamicSchedule](https://trigger.dev/docs/sdk/dynamicschedule) to register a new schedule on.
   * @param id A unique id for the schedule. This is used to identify and unregister the schedule later.
   * @param options The options for the CRON schedule.
   * @deprecated Use `DynamicSchedule.register` instead.
   */
  async registerCron(
    cacheKey: string | any[],
    dynamicSchedule: DynamicSchedule,
    id: string,
    options: CronOptions
  ) {
    return await this.runTask(
      cacheKey,
      async (task) => {
        return dynamicSchedule.register(id, {
          type: "cron",
          options,
        });
      },
      {
        name: "register-cron",
        properties: [
          { label: "schedule", text: dynamicSchedule.id },
          { label: "id", text: id },
          { label: "cron", text: options.cron },
        ],
        params: options,
      }
    );
  }

  /** `io.unregisterCron()` allows you to unregister a [DynamicSchedule](https://trigger.dev/docs/sdk/dynamicschedule) that was previously registered with `io.registerCron()`.
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param dynamicSchedule The [DynamicSchedule](https://trigger.dev/docs/sdk/dynamicschedule) to unregister a schedule on.
   * @param id A unique id for the interval. This is used to identify and unregister the interval later.
   * @deprecated Use `DynamicSchedule.unregister` instead.
   */
  async unregisterCron(cacheKey: string | any[], dynamicSchedule: DynamicSchedule, id: string) {
    return await this.runTask(
      cacheKey,
      async (task) => {
        return dynamicSchedule.unregister(id);
      },
      {
        name: "unregister-cron",
        properties: [
          { label: "schedule", text: dynamicSchedule.id },
          { label: "id", text: id },
        ],
      }
    );
  }

  /** `io.registerTrigger()` allows you to register a [DynamicTrigger](https://trigger.dev/docs/sdk/dynamictrigger) with the specified trigger params.
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param trigger The [DynamicTrigger](https://trigger.dev/docs/sdk/dynamictrigger) to register.
   * @param id A unique id for the trigger. This is used to identify and unregister the trigger later.
   * @param params The params for the trigger.
   * @deprecated Use `DynamicTrigger.register` instead.
   */
  async registerTrigger<
    TTrigger extends DynamicTrigger<EventSpecification<any>, ExternalSource<any, any, any>>,
  >(
    cacheKey: string | any[],
    trigger: TTrigger,
    id: string,
    params: ExternalSourceParams<TTrigger["source"]>
  ): Promise<{ id: string; key: string } | undefined> {
    return await this.runTask(
      cacheKey,
      async (task) => {
        const registration = await this.runTask(
          "register-source",
          async (subtask1) => {
            return trigger.register(id, params);
          },
          {
            name: "register-source",
          }
        );

        return {
          id: registration.id,
          key: registration.source.key,
        };
      },
      {
        name: "register-trigger",
        properties: [
          { label: "trigger", text: trigger.id },
          { label: "id", text: id },
        ],
        params: params as any,
      }
    );
  }

  async getAuth(cacheKey: string | any[], clientId?: string): Promise<ConnectionAuth | undefined> {
    if (!clientId) {
      return;
    }

    return this.runTask(
      cacheKey,
      async (task) => {
        return await this._triggerClient.getAuth(clientId);
      },
      { name: "get-auth" }
    );
  }

  /** `io.runTask()` allows you to run a [Task](https://trigger.dev/docs/documentation/concepts/tasks) from inside a Job run. A Task is a resumable unit of a Run that can be retried, resumed and is logged. [Integrations](https://trigger.dev/docs/integrations) use Tasks internally to perform their actions.
   *
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param callback The callback that will be called when the Task is run. The callback receives the Task and the IO as parameters.
   * @param options The options of how you'd like to run and log the Task.
   * @param onError The callback that will be called when the Task fails. The callback receives the error, the Task and the IO as parameters. If you wish to retry then return an object with a `retryAt` property.
   * @returns A Promise that resolves with the returned value of the callback.
   */
  async runTask<T extends Json<T> | void>(
    cacheKey: string | any[],
    callback: (task: ServerTask, io: IO) => Promise<T>,
    options?: RunTaskOptions,
    onError?: RunTaskErrorCallback
  ): Promise<T> {
    this.#detectAutoYield("start_task", 500);

    const parentId = this._taskStorage.getStore()?.taskId;

    if (parentId) {
      this._logger.debug("Using parent task", {
        parentId,
        cacheKey,
        options,
      });
    }

    const idempotencyKey = await generateIdempotencyKey(
      [this._id, parentId ?? "", cacheKey].flat()
    );

    const cachedTask = this._cachedTasks.get(idempotencyKey);

    if (cachedTask && cachedTask.status === "COMPLETED") {
      this._logger.debug("Using completed cached task", {
        idempotencyKey,
      });

      this._stats.cachedTaskHits++;

      return cachedTask.output as T;
    }

    if (options?.noop && this._noopTasksBloomFilter) {
      if (this._noopTasksBloomFilter.test(idempotencyKey)) {
        this._logger.debug("task idempotency key exists in noopTasksBloomFilter", {
          idempotencyKey,
        });

        this._stats.noopCachedTaskHits++;

        return {} as T;
      }
    }

    const response = await this._apiClient.runTask(
      this._id,
      {
        idempotencyKey,
        displayKey: typeof cacheKey === "string" ? cacheKey : undefined,
        noop: false,
        ...(options ?? {}),
        parentId,
      },
      {
        cachedTasksCursor: this._cachedTasksCursor,
      }
    );

    const task =
      response.version === API_VERSIONS.LAZY_LOADED_CACHED_TASKS
        ? response.body.task
        : response.body;

    if (task.forceYield) {
      this._logger.debug("Forcing yield after run task", {
        idempotencyKey,
      });

      this.#forceYield("after_run_task");
    }

    if (response.version === API_VERSIONS.LAZY_LOADED_CACHED_TASKS) {
      this._cachedTasksCursor = response.body.cachedTasks?.cursor;

      for (const cachedTask of response.body.cachedTasks?.tasks ?? []) {
        if (!this._cachedTasks.has(cachedTask.idempotencyKey)) {
          this._cachedTasks.set(cachedTask.idempotencyKey, cachedTask);

          this._logger.debug("Injecting lazy loaded task into task cache", {
            idempotencyKey: cachedTask.idempotencyKey,
          });

          this._stats.lazyLoadedCachedTasks++;
        }
      }
    }

    if (task.status === "CANCELED") {
      this._logger.debug("Task canceled", {
        idempotencyKey,
        task,
      });

      throw new CanceledWithTaskError(task);
    }

    if (task.status === "COMPLETED") {
      if (task.noop) {
        this._logger.debug("Noop Task completed", {
          idempotencyKey,
        });

        this._noopTasksBloomFilter?.add(task.idempotencyKey);
      } else {
        this._logger.debug("Cache miss", {
          idempotencyKey,
        });

        this._stats.cachedTaskMisses++;
        this.#addToCachedTasks(task);
      }

      return task.output as T;
    }

    if (task.status === "ERRORED") {
      this._logger.debug("Task errored", {
        idempotencyKey,
        task,
      });

      throw new Error(task.error ?? task?.output ? JSON.stringify(task.output) : "Task errored");
    }

    this.#detectAutoYield("before_execute_task", 1500);

    const executeTask = async () => {
      try {
        const result = await callback(task, this);

        if (task.status === "WAITING" && task.callbackUrl) {
          this._logger.debug("Waiting for remote callback", {
            idempotencyKey,
            task,
          });
          return {} as T;
        }

        const output = SerializableJsonSchema.parse(result) as T;

        this._logger.debug("Completing using output", {
          idempotencyKey,
          task,
        });

        this.#detectAutoYield("before_complete_task", 500, task, output);

        const completedTask = await this._apiClient.completeTask(this._id, task.id, {
          output: output ?? undefined,
          properties: task.outputProperties ?? undefined,
        });

        if (completedTask.forceYield) {
          this._logger.debug("Forcing yield after task completed", {
            idempotencyKey,
          });

          this.#forceYield("after_complete_task");
        }

        this._stats.executedTasks++;

        if (completedTask.status === "CANCELED") {
          throw new CanceledWithTaskError(completedTask);
        }

        this.#detectAutoYield("after_complete_task", 500);

        return output;
      } catch (error) {
        if (isTriggerError(error)) {
          throw error;
        }

        let skipRetrying = false;

        if (onError) {
          try {
            const onErrorResult = onError(error, task, this);

            if (onErrorResult) {
              if (onErrorResult instanceof Error) {
                error = onErrorResult;
              } else {
                skipRetrying = !!onErrorResult.skipRetrying;

                if (onErrorResult.retryAt && !skipRetrying) {
                  const parsedError = ErrorWithStackSchema.safeParse(onErrorResult.error);

                  throw new RetryWithTaskError(
                    parsedError.success ? parsedError.data : { message: "Unknown error" },
                    task,
                    onErrorResult.retryAt
                  );
                }
              }
            }
          } catch (innerError) {
            if (isTriggerError(innerError)) {
              throw innerError;
            }

            error = innerError;
          }
        }

        const parsedError = ErrorWithStackSchema.safeParse(error);

        if (options?.retry && !skipRetrying) {
          const retryAt = calculateRetryAt(options.retry, task.attempts - 1);

          if (retryAt) {
            throw new RetryWithTaskError(
              parsedError.success ? parsedError.data : { message: "Unknown error" },
              task,
              retryAt
            );
          }
        }

        if (parsedError.success) {
          await this._apiClient.failTask(this._id, task.id, {
            error: parsedError.data,
          });
        } else {
          const message = typeof error === "string" ? error : JSON.stringify(error);
          await this._apiClient.failTask(this._id, task.id, {
            error: { name: "Unknown error", message },
          });
        }

        throw error;
      }
    };

    if (task.status === "WAITING") {
      this._logger.debug("Task waiting", {
        idempotencyKey,
        task,
      });

      if (task.callbackUrl) {
        await this._taskStorage.run({ taskId: task.id }, executeTask);
      }

      throw new ResumeWithTaskError(task);
    }

    if (task.status === "RUNNING" && typeof task.operation === "string") {
      this._logger.debug("Task running operation", {
        idempotencyKey,
        task,
      });

      throw new ResumeWithTaskError(task);
    }

    return this._taskStorage.run({ taskId: task.id }, executeTask);
  }

  /**
   * `io.yield()` allows you to yield execution of the current run and resume it in a new function execution. Similar to `io.wait()` but does not create a task and resumes execution immediately.
   */
  yield(cacheKey: string) {
    if (!supportsFeature("yieldExecution", this._serverVersion)) {
      console.warn(
        "[trigger.dev] io.yield() is not support by the version of the Trigger.dev server you are using, you will need to upgrade your self-hosted Trigger.dev instance."
      );

      return;
    }

    if (this._yieldedExecutions.includes(cacheKey)) {
      return;
    }

    throw new YieldExecutionError(cacheKey);
  }

  /**
   * `io.brb()` is an alias of `io.yield()`
   */
  brb = this.yield.bind(this);

  /** `io.try()` allows you to run Tasks and catch any errors that are thrown, it's similar to a normal `try/catch` block but works with [io.runTask()](/sdk/io/runtask).
   * A regular `try/catch` block on its own won't work as expected with Tasks. Internally `runTask()` throws some special errors to control flow execution. This is necessary to deal with resumability, serverless timeouts, and retrying Tasks.
   * @param tryCallback The code you wish to run
   * @param catchCallback Thhis will be called if the Task fails. The callback receives the error
   * @returns A Promise that resolves with the returned value or the error
   */
  async try<TResult, TCatchResult>(
    tryCallback: () => Promise<TResult>,
    catchCallback: (error: unknown) => Promise<TCatchResult>
  ): Promise<TResult | TCatchResult> {
    try {
      return await tryCallback();
    } catch (error) {
      if (isTriggerError(error)) {
        throw error;
      }

      return await catchCallback(error);
    }
  }

  #addToCachedTasks(task: ServerTask) {
    this._cachedTasks.set(task.idempotencyKey, task);
  }

  #detectAutoYield(location: string, threshold: number = 1500, task?: ServerTask, output?: any) {
    const timeRemaining = this.#getRemainingTimeInMillis();

    if (timeRemaining && timeRemaining < threshold) {
      if (task) {
        throw new AutoYieldWithCompletedTaskExecutionError(
          task.id,
          task.outputProperties ?? [],
          output,
          {
            location,
            timeRemaining,
            timeElapsed: this.#getTimeElapsed(),
          }
        );
      } else {
        throw new AutoYieldExecutionError(location, timeRemaining, this.#getTimeElapsed());
      }
    }
  }

  #forceYield(location: string) {
    const timeRemaining = this.#getRemainingTimeInMillis();

    if (timeRemaining) {
      throw new AutoYieldExecutionError(location, timeRemaining, this.#getTimeElapsed());
    }
  }

  #getTimeElapsed() {
    return performance.now() - this._timeOrigin;
  }

  #getRemainingTimeInMillis() {
    if (this._executionTimeout) {
      return this._executionTimeout - (performance.now() - this._timeOrigin);
    }

    return undefined;
  }
}

// Generate a stable idempotency key for the key material, using a stable json stringification
async function generateIdempotencyKey(keyMaterial: any[]) {
  const keys = keyMaterial.map((key) => {
    if (typeof key === "string") {
      return key;
    }

    return stableStringify(key);
  });

  const key = keys.join(":");

  const hash = await webcrypto.subtle.digest("SHA-256", Buffer.from(key));

  return Buffer.from(hash).toString("hex");
}

function stableStringify(obj: any): string {
  function sortKeys(obj: any): any {
    if (typeof obj !== "object" || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(sortKeys);
    }

    const sortedKeys = Object.keys(obj).sort();
    const sortedObj: { [key: string]: any } = {};

    for (const key of sortedKeys) {
      sortedObj[key] = sortKeys(obj[key]);
    }

    return sortedObj;
  }

  const sortedObj = sortKeys(obj);
  return JSON.stringify(sortedObj);
}

type CallbackFunction = (
  level: "DEBUG" | "INFO" | "WARN" | "ERROR" | "LOG",
  message: string,
  properties?: Record<string, any>
) => Promise<void>;

export class IOLogger implements TaskLogger {
  constructor(private callback: CallbackFunction) {}

  /** Log: essential messages */
  log(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("LOG", message, properties);
  }

  /** For debugging: the least important log level */
  debug(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("DEBUG", message, properties);
  }

  /** Info: the second least important log level */
  info(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("INFO", message, properties);
  }

  /** Warnings: the third most important log level  */
  warn(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("WARN", message, properties);
  }

  /** Error: The second most important log level */
  error(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("ERROR", message, properties);
  }
}
