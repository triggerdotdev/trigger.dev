import { ApiClient } from "../apiClient";
import { IO, Json } from "../io";

export class IOKeyValueStore {
  constructor(
    private io: IO,
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

  async delete(cacheKey: string | any[], key: string): Promise<boolean> {
    return await this.io.runTask(
      cacheKey,
      async (task) => {
        return await this.apiClient.store.delete(this.#namespacedKey(key));
      },
      {
        name: "Key-Value Store Delete",
        icon: "database-minus",
        params: { key },
        properties: this.#sharedProperties(key),
        style: { style: "minimal" },
      }
    );
  }

  async get<T extends Json<T> = any>(cacheKey: string | any[], key: string): Promise<T> {
    return await this.io.runTask(
      cacheKey,
      async (task) => {
        return await this.apiClient.store.get(this.#namespacedKey(key));
      },
      {
        name: "Key-Value Store Get",
        icon: "database-export",
        params: { key },
        properties: this.#sharedProperties(key),
        style: { style: "minimal" },
      }
    );
  }

  async has(cacheKey: string | any[], key: string): Promise<boolean> {
    return await this.io.runTask(
      cacheKey,
      async (task) => {
        return await this.apiClient.store.has(this.#namespacedKey(key));
      },
      {
        name: "Key-Value Store Has",
        icon: "database-search",
        params: { key },
        properties: this.#sharedProperties(key),
        style: { style: "minimal" },
      }
    );
  }

  async set<T extends Json<T>>(cacheKey: string | any[], key: string, value: T): Promise<T> {
    return await this.io.runTask(
      cacheKey,
      async (task) => {
        return await this.apiClient.store.set(this.#namespacedKey(key), value);
      },
      {
        name: "Key-Value Store Set",
        icon: "database-plus",
        params: { key, value },
        properties: [
          ...this.#sharedProperties(key),
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
