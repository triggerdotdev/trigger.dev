import { ApiClient } from "../apiClient.js";
import { Json } from "../io.js";
import { runLocalStorage } from "../runLocalStorage.js";

export class KeyValueStore {
  constructor(
    private apiClient: ApiClient,
    private type: string | null = null,
    private namespace: string = ""
  ) {}

  #namespacedKey(key: string) {
    const parts = [];

    if (this.type) {
      parts.push(this.type);
    }

    if (this.namespace) {
      parts.push(this.namespace);
    }

    parts.push(key);

    return parts.join(":");
  }

  #sharedProperties(key: string) {
    return [
      {
        label: "namespace",
        text: this.type ?? "env",
      },
      {
        label: "key",
        text: key,
      },
    ];
  }

  async delete(cacheKey: string | any[], key: string): Promise<boolean>;
  async delete(key: string): Promise<boolean>;
  async delete(param1: string | any[], param2?: string): Promise<boolean> {
    const runStore = runLocalStorage.getStore();

    if (!runStore) {
      if (typeof param1 !== "string") {
        throw new Error(
          "Please use the store without a cacheKey when accessing from outside a run."
        );
      }

      return await this.apiClient.store.delete(this.#namespacedKey(param1));
    }

    const { io } = runStore;

    if (!param2) {
      throw new Error("Please provide a non-empty key when accessing the store from inside a run.");
    }

    return await io.runTask(
      param1,
      async (task) => {
        return await this.apiClient.store.delete(this.#namespacedKey(param2));
      },
      {
        name: "Key-Value Store Delete",
        icon: "database-minus",
        params: { key: param2 },
        properties: this.#sharedProperties(param2),
        style: { style: "minimal" },
      }
    );
  }

  async get<T extends Json<T> = any>(cacheKey: string | any[], key: string): Promise<T | undefined>;
  async get<T extends Json<T> = any>(key: string): Promise<T | undefined>;
  async get<T extends Json<T> = any>(
    param1: string | any[],
    param2?: string
  ): Promise<T | undefined> {
    const runStore = runLocalStorage.getStore();

    if (!runStore) {
      if (typeof param1 !== "string") {
        throw new Error(
          "Please use the store without a cacheKey when accessing from outside a run."
        );
      }

      return await this.apiClient.store.get(this.#namespacedKey(param1));
    }

    const { io } = runStore;

    if (!param2) {
      throw new Error("Please provide a non-empty key when accessing the store from inside a run.");
    }

    return await io.runTask(
      param1,
      async (task) => {
        return await this.apiClient.store.get(this.#namespacedKey(param2));
      },
      {
        name: "Key-Value Store Get",
        icon: "database-export",
        params: { key: param2 },
        properties: this.#sharedProperties(param2),
        style: { style: "minimal" },
      }
    );
  }

  async has(cacheKey: string | any[], key: string): Promise<boolean>;
  async has(key: string): Promise<boolean>;
  async has(param1: string | any[], param2?: string): Promise<boolean> {
    const runStore = runLocalStorage.getStore();

    if (!runStore) {
      if (typeof param1 !== "string") {
        throw new Error(
          "Please use the store without a cacheKey when accessing from outside a run."
        );
      }

      return await this.apiClient.store.has(this.#namespacedKey(param1));
    }

    const { io } = runStore;

    if (!param2) {
      throw new Error("Please provide a non-empty key when accessing the store from inside a run.");
    }

    return await io.runTask(
      param1,
      async (task) => {
        return await this.apiClient.store.has(this.#namespacedKey(param2));
      },
      {
        name: "Key-Value Store Has",
        icon: "database-search",
        params: { key: param2 },
        properties: this.#sharedProperties(param2),
        style: { style: "minimal" },
      }
    );
  }

  async set<T extends Json<T>>(cacheKey: string | any[], key: string, value: T): Promise<T>;
  async set<T extends Json<T>>(key: string, value: T): Promise<T>;
  async set<T extends Json<T>>(param1: string | any[], param2: string | T, param3?: T): Promise<T> {
    const runStore = runLocalStorage.getStore();

    if (!runStore) {
      if (typeof param1 !== "string") {
        throw new Error(
          "Please use the store without a cacheKey when accessing from outside a run."
        );
      }

      return await this.apiClient.store.set(this.#namespacedKey(param1), param2 as T);
    }

    const { io } = runStore;

    if (!param2 || typeof param2 !== "string") {
      throw new Error("Please provide a non-empty key when accessing the store from inside a run.");
    }

    const value = param3 as T;

    return await io.runTask(
      param1,
      async (task) => {
        return await this.apiClient.store.set(this.#namespacedKey(param2), value);
      },
      {
        name: "Key-Value Store Set",
        icon: "database-plus",
        params: { key: param2, value },
        properties: [
          ...this.#sharedProperties(param2),
          ...(typeof value !== "object" || value === null
            ? [
                {
                  label: "value",
                  text: String(value) ?? "undefined",
                },
              ]
            : []),
        ],
        style: { style: "minimal" },
      }
    );
  }
}
