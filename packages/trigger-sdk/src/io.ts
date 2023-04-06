import {
  CachedTask,
  IOTask,
  Logger,
  LogLevel,
  SerializableJson,
  ServerTask,
} from "@trigger.dev/internal";
import { webcrypto } from "node:crypto";
import { ApiClient } from "./apiClient";

export class ResumeWithTask {
  constructor(public task: ServerTask) {}
}

export type IOOptions = {
  id: string;
  apiClient: ApiClient;
  logger?: Logger;
  logLevel?: LogLevel;
  cachedTasks?: Array<CachedTask>;
};

export class IO {
  #id: string;
  #apiClient: ApiClient;
  #logger: Logger;
  #cachedTasks: Map<string, CachedTask>;

  constructor(options: IOOptions) {
    this.#id = options.id;
    this.#apiClient = options.apiClient;
    this.#logger =
      options.logger ?? new Logger("trigger.dev", options.logLevel);
    this.#cachedTasks = new Map();

    if (options.cachedTasks) {
      options.cachedTasks.forEach((task) => {
        this.#cachedTasks.set(task.id, task);
      });
    }
  }

  async runTask<T extends SerializableJson | void = void>(
    key: string | any[],
    options: IOTask,
    callback: (task: ServerTask) => Promise<T>
  ): Promise<T> {
    const idempotencyKey = await generateIdempotencyKey([this.#id, key].flat());

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

    try {
      const result = await callback(task);

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
