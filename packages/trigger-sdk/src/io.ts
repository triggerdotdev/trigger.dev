import {
  CachedTask,
  ConnectionAuth,
  LogLevel,
  Logger,
  RunTaskOptions,
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
import { EventSpecification, TriggerContext } from "./types";
import { createIOWithIntegrations } from "./ioWithIntegrations";

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
  #id: string;
  #apiClient: ApiClient;
  #client: TriggerClient;
  #logger: Logger;
  #cachedTasks: Map<string, CachedTask>;
  #taskStorage: AsyncLocalStorage<{ taskId: string }>;
  #context: TriggerContext;

  constructor(options: IOOptions) {
    this.#id = options.id;
    this.#apiClient = options.apiClient;
    this.#client = options.client;
    this.#logger =
      options.logger ?? new Logger("trigger.dev", options.logLevel);
    this.#cachedTasks = new Map();

    if (options.cachedTasks) {
      options.cachedTasks.forEach((task) => {
        this.#cachedTasks.set(task.id, task);
      });
    }

    this.#taskStorage = new AsyncLocalStorage();
    this.#context = options.context;
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
        return await this.#apiClient.updateSource(
          this.#client.name,
          options.key,
          options
        );
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
            return trigger.register(params);
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
          this.#context
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
      return await this.#client.getAuth(clientId);
    });
  }

  // TODO: investigate why errors from Github tasks are not being caught here
  async runTask<T extends SerializableJson | void = void>(
    key: string | any[],
    options: RunTaskOptions,
    callback: (task: IOTask, io: IO) => Promise<T>
  ): Promise<T> {
    const parentId = this.#taskStorage.getStore()?.taskId;

    if (parentId) {
      this.#logger.debug("Using parent task", {
        parentId,
        key,
        options,
      });
    }

    const idempotencyKey = await generateIdempotencyKey(
      [this.#id, parentId ?? "", key].flat()
    );

    const cachedTask = this.#cachedTasks.get(idempotencyKey);

    if (cachedTask) {
      this.#logger.debug("Using cached task", {
        idempotencyKey,
        cachedTask,
      });

      return cachedTask.output as T;
    }

    const task = await this.#apiClient.runTask(this.#id, {
      idempotencyKey,
      displayKey: typeof key === "string" ? key : undefined,
      noop: false,
      ...options,
      parentId,
    });

    if (task.status === "COMPLETED") {
      this.#logger.debug("Using task output", {
        idempotencyKey,
        task,
      });

      this.#addToCachedTasks(task);

      return task.output as T;
    }

    if (task.status === "ERRORED") {
      this.#logger.debug("Task errored", {
        idempotencyKey,
        task,
      });

      throw new Error(task.error ?? "Task errored");
    }

    if (task.status === "WAITING") {
      this.#logger.debug("Task waiting", {
        idempotencyKey,
        task,
      });

      throw new ResumeWithTask(task);
    }

    const executeTask = async () => {
      try {
        const result = await callback(task, this);

        this.#logger.debug("Completing using output", {
          idempotencyKey,
          task,
        });

        await this.#apiClient.completeTask(this.#id, task.id, {
          output: result ?? undefined,
        });

        return result;
      } catch (error) {
        // TODO: implement this
        throw error;
      }
    };

    return this.#taskStorage.run({ taskId: task.id }, executeTask);
  }

  #addToCachedTasks(task: ServerTask) {
    this.#cachedTasks.set(task.idempotencyKey, task);
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
