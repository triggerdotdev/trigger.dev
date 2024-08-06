import {
  API_VERSIONS,
  CachedTask,
  CompleteTaskBodyV2Input,
  ConnectionAuth,
  CronOptions,
  ErrorWithStackSchema,
  EventFilter,
  FetchPollOperation,
  FetchRequestInit,
  FetchRetryOptions,
  FetchTimeoutOptions,
  InitialStatusUpdate,
  IntervalOptions,
  RunTaskBodyInput,
  RunTaskOptions,
  SendEvent,
  SendEventOptions,
  ServerTask,
  UpdateTriggerSourceBodyV2,
  UpdateWebhookBody,
  supportsFeature,
} from "@trigger.dev/core";
import { LogLevel, Logger } from "@trigger.dev/core/logger";
import { BloomFilter } from "@trigger.dev/core/bloom";
import { AsyncLocalStorage } from "node:async_hooks";
import { webcrypto } from "node:crypto";
import { ApiClient } from "./apiClient";
import {
  AutoYieldExecutionError,
  AutoYieldRateLimitError,
  AutoYieldWithCompletedTaskExecutionError,
  CanceledWithTaskError,
  ErrorWithTask,
  ResumeWithParallelTaskError,
  ResumeWithTaskError,
  RetryWithTaskError,
  TriggerInternalError,
  YieldExecutionError,
  isTriggerError,
} from "./errors";
import { IntegrationTaskKey } from "./integrations";
import { calculateRetryAt } from "./retry";
import { TriggerStatus } from "./status";
import { TriggerClient } from "./triggerClient";
import { DynamicTrigger } from "./triggers/dynamic";
import { ExternalSource, ExternalSourceParams } from "./triggers/externalSource";
import { DynamicSchedule } from "./triggers/scheduled";
import {
  EventSpecification,
  TaskLogger,
  TriggerContext,
  WaitForEventResult,
  waitForEventSchema,
} from "./types";
import { z } from "zod";
import { KeyValueStore } from "./store/keyValueStore";
import { Buffer } from "node:buffer";

export type IOTask = ServerTask;

export type IOOptions = {
  id: string;
  jobId: string;
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

export interface OutputSerializer {
  serialize(value: any): string;
  deserialize<T>(value: string): T;
}

export class JSONOutputSerializer implements OutputSerializer {
  serialize(value: any): string {
    return JSON.stringify(value);
  }

  deserialize(value?: string): any {
    return value ? JSON.parse(value) : undefined;
  }
}

export type BackgroundFetchResponse<T> = {
  status: number;
  data: T;
  headers: Record<string, string>;
};

export class IO {
  private _id: string;
  private _jobId: string;
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
  private _outputSerializer: OutputSerializer = new JSONOutputSerializer();
  private _visitedCacheKeys: Set<string> = new Set();

  private _envStore: KeyValueStore;
  private _jobStore: KeyValueStore;
  private _runStore: KeyValueStore;

  get stats() {
    return this._stats;
  }

  constructor(options: IOOptions) {
    this._id = options.id;
    this._jobId = options.jobId;
    this._apiClient = options.apiClient;
    this._triggerClient = options.client;
    this._logger = options.logger ?? new Logger("trigger.dev", options.logLevel);
    this._cachedTasks = new Map();
    this._jobLogger = options.jobLogger;
    this._jobLogLevel = options.jobLogLevel;
    this._timeOrigin = options.timeOrigin;
    this._executionTimeout = options.executionTimeout;

    this._envStore = new KeyValueStore(options.apiClient);
    this._jobStore = new KeyValueStore(options.apiClient, "job", options.jobId);
    this._runStore = new KeyValueStore(options.apiClient, "run", options.id);

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

      if (data instanceof Error) {
        data = {
          name: data.name,
          message: data.message,
          stack: data.stack,
        };
      }

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

  /** `io.random()` is identical to `Math.random()` when called without options but ensures your random numbers are not regenerated on resume or retry. It will return a pseudo-random floating-point number between optional `min` (default: 0, inclusive) and `max` (default: 1, exclusive). Can optionally `round` to the nearest integer.
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param min Sets the lower bound (inclusive). Can't be higher than `max`.
   * @param max Sets the upper bound (exclusive). Can't be lower than `min`.
   * @param round Controls rounding to the nearest integer. Any `max` integer will become inclusive when enabled. Rounding with floating-point bounds may cause unexpected skew and boundary inclusivity.
   */
  async random(
    cacheKey: string | any[],
    {
      min = 0,
      max = 1,
      round = false,
    }: {
      min?: number;
      max?: number;
      round?: boolean;
    } = {}
  ) {
    return await this.runTask(
      cacheKey,
      async (task) => {
        if (min > max) {
          throw new Error(
            `Lower bound can't be higher than upper bound - min: ${min}, max: ${max}`
          );
        }

        if (min === max) {
          await this.logger.warn(
            `Lower and upper bounds are identical. The return value is not random and will always be: ${min}`
          );
        }

        const withinBounds = (max - min) * Math.random() + min;

        if (!round) {
          return withinBounds;
        }

        if (!Number.isInteger(min) || !Number.isInteger(max)) {
          await this.logger.warn(
            "Rounding enabled with floating-point bounds. This may cause unexpected skew and boundary inclusivity."
          );
        }

        const rounded = Math.round(withinBounds);

        return rounded;
      },
      {
        name: "random",
        icon: "dice-5-filled",
        params: { min, max, round },
        properties: [
          ...(min === 0
            ? []
            : [
                {
                  label: "min",
                  text: String(min),
                },
              ]),
          ...(max === 1
            ? []
            : [
                {
                  label: "max",
                  text: String(max),
                },
              ]),
          ...(round === false
            ? []
            : [
                {
                  label: "round",
                  text: String(round),
                },
              ]),
        ],
        style: { style: "minimal" },
      }
    );
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

  async waitForEvent<T extends z.ZodTypeAny = z.ZodTypeAny>(
    cacheKey: string | any[],
    event: {
      name: string;
      schema?: T;
      filter?: EventFilter;
      source?: string;
      contextFilter?: EventFilter;
      accountId?: string;
    },
    options?: { timeoutInSeconds?: number }
  ): Promise<WaitForEventResult<z.output<T>>> {
    const timeoutInSeconds = options?.timeoutInSeconds ?? 60 * 60;

    return (await this.runTask(
      cacheKey,
      async (task, io) => {
        if (!task.callbackUrl) {
          throw new Error("No callbackUrl found on task");
        }

        await this.triggerClient.createEphemeralEventDispatcher({
          url: task.callbackUrl,
          name: event.name,
          filter: event.filter,
          contextFilter: event.contextFilter,
          source: event.source,
          accountId: event.accountId,
          timeoutInSeconds,
        });

        return {} as Promise<{}>;
      },
      {
        name: "Wait for Event",
        icon: "custom-event",
        params: {
          name: event.name,
          source: event.source,
          filter: event.filter,
          contextFilter: event.contextFilter,
          accountId: event.accountId,
        },
        callback: {
          enabled: true,
          timeoutInSeconds,
        },
        properties: [
          {
            label: "Event",
            text: event.name,
          },
          {
            label: "Timeout",
            text: `${timeoutInSeconds}s`,
          },
          ...(event.source ? [{ label: "Source", text: event.source }] : []),
          ...(event.accountId ? [{ label: "Account ID", text: event.accountId }] : []),
        ],
        parseOutput: (output) => {
          return waitForEventSchema(event.schema ?? z.any()).parse(output);
        },
      }
    )) as WaitForEventResult<z.output<T>>;
  }

  /** `io.waitForRequest()` allows you to pause the execution of a run until the url provided in the callback is POSTed to.
   *  This is useful for integrating with external services that require a callback URL to be provided, or if you want to be able to wait until an action is performed somewhere else in your system.
   *  @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   *  @param callback A callback function that will provide the unique URL to POST to.
   *  @param options Options for the callback.
   *  @param options.timeoutInSeconds How long to wait for the request to be POSTed to the callback URL before timing out. Defaults to 1hr.
   *  @returns The POSTed request JSON body.
   *  @example
   * ```ts
    const result = await io.waitForRequest<{ message: string }>(
      "wait-for-request",
      async (url, task) => {
        // Save the URL somewhere so you can POST to it later
        // Or send it to an external service that will POST to it
      },
      { timeoutInSeconds: 60 } // wait 60 seconds
    );
    * ```
   */
  async waitForRequest<T extends Json<T> | unknown = unknown>(
    cacheKey: string | any[],
    callback: (url: string) => Promise<unknown>,
    options?: { timeoutInSeconds?: number }
  ): Promise<T> {
    const timeoutInSeconds = options?.timeoutInSeconds ?? 60 * 60;

    return (await this.runTask(
      cacheKey,
      async (task, io) => {
        if (!task.callbackUrl) {
          throw new Error("No callbackUrl found on task");
        }

        task.outputProperties = [
          {
            label: "Callback URL",
            text: task.callbackUrl,
          },
        ];

        return callback(task.callbackUrl) as Promise<{}>;
      },
      {
        name: "Wait for Request",
        icon: "clock",
        callback: {
          enabled: true,
          timeoutInSeconds: options?.timeoutInSeconds,
        },
        properties: [
          {
            label: "Timeout",
            text: `${timeoutInSeconds}s`,
          },
        ],
      }
    )) as T;
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
    options?: {
      retry?: FetchRetryOptions;
      timeout?: FetchTimeoutOptions;
    }
  ): Promise<TResponseData> {
    const urlObject = new URL(url);

    return (await this.runTask(
      cacheKey,
      async (task) => {
        console.log("task context", task.context);

        return task.output;
      },
      {
        name: `fetch ${urlObject.hostname}${urlObject.pathname}`,
        params: { url, requestInit, retry: options?.retry, timeout: options?.timeout },
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
          ...(options?.timeout
            ? [{ label: "timeout", text: `${options.timeout.durationInMs}ms` }]
            : []),
        ],
        retry: {
          limit: 0,
        },
      }
    )) as TResponseData;
  }

  /** `io.backgroundPoll()` will fetch data from a URL on an interval. The actual `fetch` requests are performed on the Trigger.dev server, so you don't have to worry about serverless function timeouts.
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param params The options for the background poll
   * @param params.url The URL to fetch from.
   * @param params.requestInit The options for the request, like headers and method
   * @param params.responseFilter An [EventFilter](https://trigger.dev/docs/documentation/guides/event-filter) that allows you to specify when to stop polling.
   * @param params.interval The interval in seconds to poll the URL in seconds. Defaults to 10 seconds which is the minimum.
   * @param params.timeout The timeout in seconds for each request in seconds. Defaults to 10 minutes. Minimum is 60 seconds and max is 1 hour
   * @param params.requestTimeout An optional object that allows you to timeout individual fetch requests
   * @param params.requestTimeout An optional object that allows you to timeout individual fetch requests
   * @param params.requestTimeout.durationInMs The duration in milliseconds to timeout the request
   * 
   * @example
   * ```ts
   * const result = await io.backgroundPoll<{ id: string; status: string; }>("poll", {
      url: `http://localhost:3030/api/v1/runs/${run.id}`,
      requestInit: {
        headers: {
          Accept: "application/json",
          Authorization: redactString`Bearer ${process.env["TRIGGER_API_KEY"]!}`,
        },
      },
      interval: 10,
      timeout: 600,
      responseFilter: {
        status: [200],
        body: {
          status: ["SUCCESS"],
        },
      },
    });
    * ```
   */
  async backgroundPoll<TResponseData>(
    cacheKey: string | any[],
    params: FetchPollOperation
  ): Promise<TResponseData> {
    const urlObject = new URL(params.url);

    return (await this.runTask(
      cacheKey,
      async (task) => {
        return task.output;
      },
      {
        name: `poll ${urlObject.hostname}${urlObject.pathname}`,
        params,
        operation: "fetch-poll",
        icon: "clock-bolt",
        noop: false,
        properties: [
          {
            label: "url",
            text: params.url,
          },
          {
            label: "interval",
            text: `${params.interval}s`,
          },
          {
            label: "timeout",
            text: `${params.timeout}s`,
          },
        ],
        retry: {
          limit: 0,
        },
      }
    )) as TResponseData;
  }

  /** `io.backgroundFetchResponse()` fetches data from a URL that can take longer that the serverless timeout. The actual `fetch` request is performed on the Trigger.dev platform, and the response is sent back to you.
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
  async backgroundFetchResponse<TResponseData>(
    cacheKey: string | any[],
    url: string,
    requestInit?: FetchRequestInit,
    options?: {
      retry?: FetchRetryOptions;
      timeout?: FetchTimeoutOptions;
    }
  ): Promise<BackgroundFetchResponse<TResponseData>> {
    const urlObject = new URL(url);

    return (await this.runTask(
      cacheKey,
      async (task) => {
        return task.output;
      },
      {
        name: `fetch response ${urlObject.hostname}${urlObject.pathname}`,
        params: { url, requestInit, retry: options?.retry, timeout: options?.timeout },
        operation: "fetch-response",
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
          ...(options?.timeout
            ? [{ label: "timeout", text: `${options.timeout.durationInMs}ms` }]
            : []),
        ],
        retry: {
          limit: 0,
        },
      }
    )) as BackgroundFetchResponse<TResponseData>;
  }

  /** `io.sendEvent()` allows you to send an event from inside a Job run. The sent event will trigger any Jobs that are listening for that event (based on the name).
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
        name: "Send Event",
        params: { event, options },
        icon: "send",
        properties: [
          {
            label: "name",
            text: event.name,
          },
          ...(event?.id ? [{ label: "ID", text: event.id }] : []),
          ...sendEventOptionsProperties(options),
        ],
      }
    );
  }

  /** `io.sendEvents()` allows you to send multiple events from inside a Job run. The sent events will trigger any Jobs that are listening for those events (based on the name).
   * @param cacheKey Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param event The events to send. The event names must match the names of the events that your Jobs are listening for.
   * @param options Options for sending the events.
   */
  async sendEvents(cacheKey: string | any[], events: SendEvent[], options?: SendEventOptions) {
    return await this.runTask(
      cacheKey,
      async (task) => {
        return await this._triggerClient.sendEvents(events, options);
      },
      {
        name: "Send Multiple Events",
        params: { events, options },
        icon: "send",
        properties: [
          {
            label: "Total Events",
            text: String(events.length),
          },
          ...sendEventOptionsProperties(options),
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

  async updateWebhook(cacheKey: string | any[], options: { key: string } & UpdateWebhookBody) {
    return this.runTask(
      cacheKey,
      async (task) => {
        return await this._apiClient.updateWebhook(options.key, options);
      },
      {
        name: "Update Webhook Source",
        icon: "refresh",
        properties: [
          {
            label: "key",
            text: options.key,
          },
        ],
        params: options,
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

  async parallel<T extends Json<T> | void, TItem>(
    cacheKey: string | any[],
    items: Array<TItem>,
    callback: (item: TItem, index: number) => Promise<T>,
    options?: Pick<RunTaskOptions, "name" | "properties">
  ): Promise<Array<T>> {
    const results = await this.runTask(
      cacheKey,
      async (task) => {
        const outcomes = await Promise.allSettled(
          items.map((item, index) => spaceOut(() => callback(item, index), index, 15))
        );

        // If all the outcomes are fulfilled, return the values
        if (outcomes.every((outcome) => outcome.status === "fulfilled")) {
          return outcomes.map(
            (outcome) => (outcome as PromiseFulfilledResult<T>).value
          ) as Array<{}>;
        }

        // If they any of the errors are non internal errors, throw the first one
        const nonInternalErrors = outcomes
          .filter((outcome) => outcome.status === "rejected" && !isTriggerError(outcome.reason))
          .map((outcome) => outcome as PromiseRejectedResult);

        if (nonInternalErrors.length > 0) {
          throw nonInternalErrors[0].reason;
        }

        // gather all the internal errors
        const internalErrors = outcomes
          .filter((outcome) => outcome.status === "rejected" && isTriggerError(outcome.reason))
          .map((outcome) => outcome as PromiseRejectedResult)
          .map((outcome) => outcome.reason as TriggerInternalError);

        throw new ResumeWithParallelTaskError(task, internalErrors);
      },
      {
        name: "parallel",
        parallel: true,
        ...(options ?? {}),
      }
    );

    return results as unknown as Array<T>;
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
    options?: RunTaskOptions & { parseOutput?: (output: unknown) => T },
    onError?: RunTaskErrorCallback
  ): Promise<T> {
    const parentId = this._taskStorage.getStore()?.taskId;

    if (parentId) {
      this._logger.debug("Using parent task", {
        parentId,
        cacheKey,
        options,
      });
    }

    //don't auto-yield if it's a no-op and a subtask (e.g. a log inside a task)
    const isSubtaskNoop = options?.noop === true && parentId !== undefined;
    if (!isSubtaskNoop) {
      this.#detectAutoYield("start_task", 500);
    }

    const idempotencyKey = await generateIdempotencyKey(
      [this._id, parentId ?? "", cacheKey].flat()
    );

    if (this._visitedCacheKeys.has(idempotencyKey)) {
      if (typeof cacheKey === "string") {
        throw new Error(
          `Task with cacheKey "${cacheKey}" has already been executed in this run. Each task must have a unique cacheKey.`
        );
      } else {
        throw new Error(
          `Task with cacheKey "${cacheKey.join(
            "-"
          )}" has already been executed in this run. Each task must have a unique cacheKey.`
        );
      }
    }

    this._visitedCacheKeys.add(idempotencyKey);

    const cachedTask = this._cachedTasks.get(idempotencyKey);

    if (cachedTask && cachedTask.status === "COMPLETED") {
      this._logger.debug("Using completed cached task", {
        idempotencyKey,
      });

      this._stats.cachedTaskHits++;

      return options?.parseOutput
        ? options.parseOutput(cachedTask.output)
        : (cachedTask.output as T);
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

    const runOptions = { ...(options ?? {}), parseOutput: undefined };

    const response = await this.#doRunTask({
      idempotencyKey,
      displayKey: typeof cacheKey === "string" ? cacheKey : undefined,
      noop: false,
      ...(runOptions ?? {}),
      parentId,
    });

    if (!response) {
      this.#forceYield("failed_task_run");
      throw new Error("Failed to run task"); // this shouldn't actually happen, because forceYield will throw
    }

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

      return options?.parseOutput ? options.parseOutput(task.output) : (task.output as T);
    }

    if (task.status === "ERRORED") {
      this._logger.debug("Task errored", {
        idempotencyKey,
        task,
      });

      throw new ErrorWithTask(
        task,
        task.error ?? task?.output ? JSON.stringify(task.output) : "Task errored"
      );
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

        const output = this._outputSerializer.serialize(result);

        this._logger.debug("Completing using output", {
          idempotencyKey,
          task,
        });

        this.#detectAutoYield("before_complete_task", 500, task, output);

        const completedTask = await this.#doCompleteTask(task.id, {
          output,
          properties: task.outputProperties ?? undefined,
        });

        if (!completedTask) {
          this.#forceYield("before_complete_task", task, output);
          throw new Error("Failed to complete task"); // this shouldn't actually happen, because forceYield will throw
        }

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

        const deserializedOutput = this._outputSerializer.deserialize<T>(output);

        return options?.parseOutput ? options.parseOutput(deserializedOutput) : deserializedOutput;
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

        if (error instanceof ErrorWithTask) {
          // This means a subtask errored, so we need to update the parent task and not retry it
          await this._apiClient.failTask(this._id, task.id, {
            error: error.cause.output as any,
          });

          throw error;
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

  /** `io.try()` allows you to run Tasks and catch any errors that are thrown, it's similar to a normal `try/catch` block but works with [io.runTask()](https://trigger.dev/docs/sdk/io/runtask).
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

  get store() {
    return {
      env: this._envStore,
      job: this._jobStore,
      run: this._runStore,
    };
  }

  #addToCachedTasks(task: ServerTask) {
    this._cachedTasks.set(task.idempotencyKey, task);
  }

  async #doRunTask(task: RunTaskBodyInput) {
    try {
      return await this._apiClient.runTask(this._id, task, {
        cachedTasksCursor: this._cachedTasksCursor,
      });
    } catch (error) {
      if (error instanceof AutoYieldRateLimitError) {
        this._logger.debug("AutoYieldRateLimitError", {
          error,
        });

        throw error;
      }

      return;
    }
  }

  async #doCompleteTask(id: string, task: CompleteTaskBodyV2Input) {
    try {
      return await this._apiClient.completeTask(this._id, id, task);
    } catch (error) {
      return;
    }
  }

  #detectAutoYield(location: string, threshold: number = 1500, task?: ServerTask, output?: string) {
    const timeRemaining = this.#getRemainingTimeInMillis();

    if (timeRemaining && timeRemaining < threshold) {
      if (task) {
        throw new AutoYieldWithCompletedTaskExecutionError(
          task.id,
          task.outputProperties ?? [],
          {
            location,
            timeRemaining,
            timeElapsed: this.#getTimeElapsed(),
          },
          output
        );
      } else {
        throw new AutoYieldExecutionError(location, timeRemaining, this.#getTimeElapsed());
      }
    }
  }

  #forceYield(location: string, task?: ServerTask, output?: string) {
    const timeRemaining = this.#getRemainingTimeInMillis();

    if (timeRemaining) {
      if (task) {
        throw new AutoYieldWithCompletedTaskExecutionError(
          task.id,
          task.outputProperties ?? [],
          {
            location,
            timeRemaining,
            timeElapsed: this.#getTimeElapsed(),
          },
          output
        );
      } else {
        throw new AutoYieldExecutionError(location, timeRemaining, this.#getTimeElapsed());
      }
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

// Space out the execution of the callback by a delay of index * delay
async function spaceOut<T>(callback: () => Promise<T>, index: number, delay: number): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, index * delay));

  return await callback();
}

function sendEventOptionsProperties(options?: SendEventOptions) {
  return [
    ...(options?.accountId ? [{ label: "Account ID", text: options.accountId }] : []),
    ...(options?.deliverAfter
      ? [{ label: "Deliver After", text: `${options.deliverAfter}s` }]
      : []),
    ...(options?.deliverAt ? [{ label: "Deliver At", text: options.deliverAt.toISOString() }] : []),
  ];
}
