import {
  CachedTask,
  LogLevel,
  Logger,
  RegisterHttpEventSourceBody,
  RunTaskOptions,
  SerializableJson,
  ServerTask,
  UpdateHttpEventSourceBody,
} from "@trigger.dev/internal";
import { AsyncLocalStorage } from "node:async_hooks";
import { webcrypto } from "node:crypto";
import { ApiClient } from "./apiClient";
import { Job } from "./job";
import { TriggerClient } from "./triggerClient";
import { Trigger } from "./types";

export class ResumeWithTask {
  constructor(public task: ServerTask) {}
}

export type IOTask = ServerTask;

export type IOOptions = {
  id: string;
  apiClient: ApiClient;
  client: TriggerClient;
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
  }

  async registerHttpSource(
    key: string | any[],
    options: RegisterHttpEventSourceBody
  ) {
    return this.runTask(
      key,
      {
        name: "Register HTTP Source",
        description: `Register HTTP Source ${options.key}`,
        elements: [
          {
            label: "Key",
            text: options.key,
          },
        ],
        redact: {
          paths: ["secret"],
        },
      },
      async (task) => {
        return await this.#apiClient.registerHttpSource(
          this.#client.name,
          options
        );
      }
    );
  }

  async updateHttpSource(
    key: string | any[],
    options: { id: string } & UpdateHttpEventSourceBody
  ) {
    return this.runTask(
      key,
      {
        name: "Update HTTP Source",
        description: `Update HTTP Source ${options.id}`,
        elements: [
          {
            label: "id",
            text: options.id,
          },
        ],
        redact: {
          paths: ["secret"],
        },
      },
      async (task) => {
        return await this.#apiClient.updateHttpSource(
          this.#client.name,
          options.id,
          options
        );
      }
    );
  }

  // TODO: use internal job system for this
  async on<T extends SerializableJson | void = void>(
    key: string | any[],
    trigger: Trigger<T>
  ) {
    const metadata = trigger.toJSON();

    return this.runTask<T>(
      key,
      {
        name: metadata.title,
        elements: metadata.elements,
        trigger: trigger.toJSON(),
      },
      async (task) => {
        return task.output as T;
      }
    );
  }

  async addTriggerVariant<TTrigger extends Trigger<any>>(
    job: Job<TTrigger, any>,
    id: string,
    trigger: TTrigger
  ) {
    const metadata = trigger.toJSON();

    const response = await this.runTask(
      id,
      {
        name: `Add trigger to job`,
        description: `Add trigger ${metadata.title} to job ${job.id}`,
        elements: metadata.elements,
      },
      async (task) => {
        const subResponse1 = await this.runTask(
          "register-trigger-variant",
          {
            name: `Register trigger variant`,
            description: `Register trigger variant ${metadata.title} to job ${job.id}`,
            elements: metadata.elements,
          },
          async (task) => {
            return await this.#apiClient.addTriggerVariant(
              this.#client.name,
              job.id,
              job.version,
              {
                id,
                trigger: metadata,
              }
            );
          }
        );

        if (subResponse1.ready) {
          return subResponse1;
        }

        await this.runTask(
          "prepare-trigger-variant",
          {
            name: "Prepare trigger variant",
            description: `Prepare trigger variant ${metadata.title} to job ${job.id}`,
            elements: metadata.elements,
          },
          async (task) => {
            // TODO: trigger.prepare should take the io as an argument and everything inside there should happen within subtasks
            // the way we can do this is by reusing the job system when running the trigger.prepare function, using something like "Shadow Jobs"
            // that are used internally by the trigger.dev system, but are not exposed to the user
            // Each trigger that needs to be prepared will have a shadow job that is run in the background
            // so instead of writing custom code for each thing trigger needs to do internally, we can just use the job system
            // this will make our internal code much more reliable, and it will also allow us to do stuff like registering a trigger
            // both at "static" time and at "runtime", for example when listening for a webhook in the middle of a job
            // or registering a trigger variant when a job is running
            // This is crucial because if we have a trigger.prepare function that makes many different API calls, we might start running into function timeout issues
            // We could also explore showing these to the user, under something like "internal jobs" so we can surface more information to the user about what the system is doing
            // We need to make a new "child IO" here that is used for preparing the trigger which does not have access to other connections or auth in the context
            // return await trigger.prepare(this.#client, subResponse1.auth);
          }
        );

        return { ok: true };
      }
    );
  }

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
