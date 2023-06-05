import {
  CachedTask,
  ConnectionAuth,
  CronOptions,
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
import { TriggerClient } from "./triggerClient";
import { DynamicTrigger } from "./triggers/dynamic";
import {
  ExternalSource,
  ExternalSourceParams,
} from "./triggers/externalSource";
import { EventSpecification, TaskLogger, TriggerContext } from "./types";
import { createIOWithIntegrations } from "./ioWithIntegrations";
import { DynamicSchedule } from "./triggers/scheduled";

export class ResumeWithTask {
  constructor(public task: ServerTask) {}
}

export type IOTask = ServerTask;

export type IOOptions = {
  id: string;
  apiClient: ApiClient;
  client: TriggerClient;
  context: TriggerContext;
  logger?: Logger;
  logLevel?: LogLevel;
  cachedTasks?: Array<CachedTask>;
};

export class IO {
  private _id: string;
  private _apiClient: ApiClient;
  private _triggerClient: TriggerClient;
  private _logger: Logger;
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

    if (options.cachedTasks) {
      options.cachedTasks.forEach((task) => {
        this._cachedTasks.set(task.id, task);
      });
    }

    this._taskStorage = new AsyncLocalStorage();
    this._context = options.context;
  }

  get logger() {
    return new IOLogger(async (level, message, data) => {
      switch (level) {
        case "DEBUG": {
          this._logger.debug(message, data);
          break;
        }
        case "INFO": {
          this._logger.info(message, data);
          break;
        }
        case "WARN": {
          this._logger.warn(message, data);
          break;
        }
        case "ERROR": {
          this._logger.error(message, data);
          break;
        }
      }

      await this.runTask(
        [message, level],
        {
          name: "log",
          icon: "log",
          description: message,
          params: data,
          elements: [{ label: "Level", text: level }],
          style: { style: "minimal", variant: level.toLowerCase() },
          noop: true,
        },
        async (task) => {}
      );
    });
  }

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

  async sendCustomEvent(
    key: string | any[],
    event: SendEvent,
    options?: SendEventOptions
  ) {
    return await this.runTask(
      key,
      {
        name: "sendCustomEvent",
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
        elements: [
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
          this._triggerClient.name,
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
        elements: [
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
        elements: [
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
        elements: [
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
        elements: [
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
        elements: [
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

  // TODO: investigate why errors from Github tasks are not being caught here
  async runTask<T extends SerializableJson | void = void>(
    key: string | any[],
    options: RunTaskOptions,
    callback: (task: IOTask, io: IO) => Promise<T>
  ): Promise<T> {
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

      return cachedTask.output as T;
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

      return task.output as T;
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

      throw new ResumeWithTask(task);
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
        // TODO: implement this
        throw error;
      }
    };

    return this._taskStorage.run({ taskId: task.id }, executeTask);
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
  level: "DEBUG" | "INFO" | "WARN" | "ERROR",
  message: string,
  properties?: Record<string, any>
) => Promise<void>;

export class IOLogger implements TaskLogger {
  constructor(private callback: CallbackFunction) {}

  debug(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("DEBUG", message, properties);
  }
  info(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("INFO", message, properties);
  }
  warn(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("WARN", message, properties);
  }
  error(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("ERROR", message, properties);
  }
}
