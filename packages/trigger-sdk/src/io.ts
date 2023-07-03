import {
  CachedTask,
  ConnectionAuth,
  CronOptions,
  ErrorWithStackSchema,
  FetchRequestInit,
  FetchRetryOptions,
  IntervalOptions,
  LogLevel,
  Logger,
  RunTaskOptions,
  SendEvent,
  SendEventOptions,
  SerializableJson,
  ServerTask,
  UpdateTriggerSourceBody,
} from "@trigger.dev/internal";
import { AsyncLocalStorage } from "node:async_hooks";
import { webcrypto } from "node:crypto";
import { ApiClient } from "./apiClient";
import {
  ResumeWithTaskError,
  RetryWithTaskError,
  isTriggerError,
} from "./errors";
import { createIOWithIntegrations } from "./ioWithIntegrations";
import { calculateRetryAt } from "./retry";
import { TriggerClient } from "./triggerClient";
import { DynamicTrigger } from "./triggers/dynamic";
import {
  ExternalSource,
  ExternalSourceParams,
} from "./triggers/externalSource";
import { DynamicSchedule } from "./triggers/scheduled";
import { EventSpecification, TaskLogger, TriggerContext } from "./types";

export type IOTask = ServerTask;

export type IOOptions = {
  id: string;
  apiClient: ApiClient;
  client: TriggerClient;
  context: TriggerContext;
  logger?: Logger;
  logLevel?: LogLevel;
  jobLogger?: Logger;
  jobLogLevel: LogLevel;
  cachedTasks?: Array<CachedTask>;
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
  private _context: TriggerContext;

  constructor(options: IOOptions) {
    this._id = options.id;
    this._apiClient = options.apiClient;
    this._triggerClient = options.client;
    this._logger =
      options.logger ?? new Logger("trigger.dev", options.logLevel);
    this._cachedTasks = new Map();
    this._jobLogger = options.jobLogger;
    this._jobLogLevel = options.jobLogLevel;

    if (options.cachedTasks) {
      options.cachedTasks.forEach((task) => {
        this._cachedTasks.set(task.id, task);
      });
    }

    this._taskStorage = new AsyncLocalStorage();
    this._context = options.context;
  }

  /** Used to send log messages to the [Run log](https://trigger.dev/docs/documentation/guides/viewing-runs). */
  get logger() {
    return new IOLogger(async (level, message, data) => {
      let logLevel: LogLevel = "info";

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

      if (Logger.satisfiesLogLevel(logLevel, this._jobLogLevel)) {
        await this.runTask(
          [message, level],
          {
            name: "log",
            icon: "log",
            description: message,
            params: data,
            properties: [{ label: "Level", text: level }],
            style: { style: "minimal", variant: level.toLowerCase() },
            noop: true,
          },
          async (task) => {}
        );
      }
    });
  }

  /** `io.wait()` waits for the specified amount of time before continuing the Job. Delays work even if you're on a serverless platform with timeouts, or if your server goes down. They utilize [resumability](https://trigger.dev/docs/documentation/concepts/resumability) to ensure that the Run can be resumed after the delay.
   * @param key Should be a stable and unique key inside the `run()`. See [resumability](https://trigger.dev/docs/documentation/concepts/resumability) for more information.
   * @param seconds The number of seconds to wait. This can be very long, serverless timeouts are not an issue.
   */
  async wait(key: string | any[], seconds: number) {
    return await this.runTask(
      key,
      {
        name: "wait",
        icon: "clock",
        params: { seconds },
        noop: true,
        delayUntil: new Date(Date.now() + seconds * 1000),
        style: { style: "minimal" },
      },
      async (task) => {}
    );
  }

  async backgroundFetch<TResponseData>(
    key: string | any[],
    url: string,
    requestInit?: FetchRequestInit,
    retry?: FetchRetryOptions
  ): Promise<TResponseData> {
    const urlObject = new URL(url);

    return (await this.runTask(
      key,
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
      },
      async (task) => {
        return task.output;
      }
    )) as TResponseData;
  }

  async sendEvent(
    key: string | any[],
    event: SendEvent,
    options?: SendEventOptions
  ) {
    return await this.runTask(
      key,
      {
        name: "sendEvent",
        params: { event, options },
      },
      async (task) => {
        return await this._triggerClient.sendEvent(event, options);
      }
    );
  }

  async updateSource(
    key: string | any[],
    options: { key: string } & UpdateTriggerSourceBody
  ) {
    return this.runTask(
      key,
      {
        name: "Update Source",
        description: `Update Source ${options.key}`,
        properties: [
          {
            label: "key",
            text: options.key,
          },
        ],
        redact: {
          paths: ["secret"],
        },
      },
      async (task) => {
        return await this._apiClient.updateSource(
          this._triggerClient.id,
          options.key,
          options
        );
      }
    );
  }

  async registerInterval(
    key: string | any[],
    dynamicSchedule: DynamicSchedule,
    id: string,
    options: IntervalOptions
  ) {
    return await this.runTask(
      key,
      {
        name: "register-interval",
        properties: [
          { label: "schedule", text: dynamicSchedule.id },
          { label: "id", text: id },
          { label: "seconds", text: options.seconds.toString() },
        ],
        params: options,
      },
      async (task) => {
        return dynamicSchedule.register(id, {
          type: "interval",
          options,
        });
      }
    );
  }

  async unregisterInterval(
    key: string | any[],
    dynamicSchedule: DynamicSchedule,
    id: string
  ) {
    return await this.runTask(
      key,
      {
        name: "unregister-interval",
        properties: [
          { label: "schedule", text: dynamicSchedule.id },
          { label: "id", text: id },
        ],
      },
      async (task) => {
        return dynamicSchedule.unregister(id);
      }
    );
  }

  async registerCron(
    key: string | any[],
    dynamicSchedule: DynamicSchedule,
    id: string,
    options: CronOptions
  ) {
    return await this.runTask(
      key,
      {
        name: "register-cron",
        properties: [
          { label: "schedule", text: dynamicSchedule.id },
          { label: "id", text: id },
          { label: "cron", text: options.cron },
        ],
        params: options,
      },
      async (task) => {
        return dynamicSchedule.register(id, {
          type: "cron",
          options,
        });
      }
    );
  }

  async unregisterCron(
    key: string | any[],
    dynamicSchedule: DynamicSchedule,
    id: string
  ) {
    return await this.runTask(
      key,
      {
        name: "unregister-cron",
        properties: [
          { label: "schedule", text: dynamicSchedule.id },
          { label: "id", text: id },
        ],
      },
      async (task) => {
        return dynamicSchedule.unregister(id);
      }
    );
  }

  async registerTrigger<
    TTrigger extends DynamicTrigger<
      EventSpecification<any>,
      ExternalSource<any, any, any>
    >
  >(
    key: string | any[],
    trigger: TTrigger,
    id: string,
    params: ExternalSourceParams<TTrigger["source"]>
  ): Promise<{ id: string; key: string } | undefined> {
    return await this.runTask(
      key,
      {
        name: "register-trigger",
        properties: [
          { label: "trigger", text: trigger.id },
          { label: "id", text: id },
        ],
        params: params as any,
      },
      async (task) => {
        const registration = await this.runTask(
          "register-source",
          {
            name: "register-source",
          },
          async (subtask1) => {
            return trigger.register(id, params);
          }
        );

        const connection = await this.getAuth(
          "get-auth",
          registration.source.clientId
        );

        const io = createIOWithIntegrations(
          // @ts-ignore
          this,
          {
            integration: connection,
          },
          {
            integration: trigger.source.integration,
          }
        );

        const updates = await trigger.source.register(
          params,
          registration,
          io,
          this._context
        );

        if (!updates) {
          // TODO: do something here?
          return;
        }

        return await this.updateSource("update-source", {
          key: registration.source.key,
          ...updates,
        });
      }
    );
  }

  async getAuth(
    key: string | any[],
    clientId?: string
  ): Promise<ConnectionAuth | undefined> {
    if (!clientId) {
      return;
    }

    return this.runTask(key, { name: "get-auth" }, async (task) => {
      return await this._triggerClient.getAuth(clientId);
    });
  }

  async runTask<TResult extends SerializableJson | void = void>(
    key: string | any[],
    options: RunTaskOptions,
    callback: (task: IOTask, io: IO) => Promise<TResult>,
    onError?: (
      error: unknown,
      task: IOTask,
      io: IO
    ) => { retryAt: Date; error?: Error; jitter?: number } | undefined | void
  ): Promise<TResult> {
    const parentId = this._taskStorage.getStore()?.taskId;

    if (parentId) {
      this._logger.debug("Using parent task", {
        parentId,
        key,
        options,
      });
    }

    const idempotencyKey = await generateIdempotencyKey(
      [this._id, parentId ?? "", key].flat()
    );

    const cachedTask = this._cachedTasks.get(idempotencyKey);

    if (cachedTask) {
      this._logger.debug("Using cached task", {
        idempotencyKey,
        cachedTask,
      });

      return cachedTask.output as TResult;
    }

    const task = await this._apiClient.runTask(this._id, {
      idempotencyKey,
      displayKey: typeof key === "string" ? key : undefined,
      noop: false,
      ...options,
      parentId,
    });

    if (task.status === "COMPLETED") {
      this._logger.debug("Using task output", {
        idempotencyKey,
        task,
      });

      this.#addToCachedTasks(task);

      return task.output as TResult;
    }

    if (task.status === "ERRORED") {
      this._logger.debug("Task errored", {
        idempotencyKey,
        task,
      });

      throw new Error(task.error ?? "Task errored");
    }

    if (task.status === "WAITING") {
      this._logger.debug("Task waiting", {
        idempotencyKey,
        task,
      });

      throw new ResumeWithTaskError(task);
    }

    if (task.status === "RUNNING" && typeof task.operation === "string") {
      this._logger.debug("Task running operation", {
        idempotencyKey,
        task,
      });

      throw new ResumeWithTaskError(task);
    }

    const executeTask = async () => {
      try {
        const result = await callback(task, this);

        this._logger.debug("Completing using output", {
          idempotencyKey,
          task,
        });

        await this._apiClient.completeTask(this._id, task.id, {
          output: result ?? undefined,
        });

        return result;
      } catch (error) {
        if (isTriggerError(error)) {
          throw error;
        }

        if (onError) {
          const onErrorResult = onError(error, task, this);

          if (onErrorResult) {
            const parsedError = ErrorWithStackSchema.safeParse(
              onErrorResult.error
            );

            throw new RetryWithTaskError(
              parsedError.success
                ? parsedError.data
                : { message: "Unknown error" },
              task,
              onErrorResult.retryAt
            );
          }
        }

        const parsedError = ErrorWithStackSchema.safeParse(error);

        if (options.retry) {
          const retryAt = calculateRetryAt(options.retry, task.attempts - 1);

          if (retryAt) {
            throw new RetryWithTaskError(
              parsedError.success
                ? parsedError.data
                : { message: "Unknown error" },
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
          await this._apiClient.failTask(this._id, task.id, {
            error: { message: JSON.stringify(error), name: "Unknown Error" },
          });
        }

        throw error;
      }
    };

    return this._taskStorage.run({ taskId: task.id }, executeTask);
  }

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
