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

  #properties(key: string, value?: any) {
    return [
      {
        label: "namespace",
        text: this.type ?? "env",
      },
      {
        label: "key",
        text: key,
      },
      ...(typeof value === "string"
        ? [
            {
              label: "value",
              text: value,
            },
          ]
        : []),
    ];
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
        properties: this.#properties(key),
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
        properties: this.#properties(key, value),
        style: { style: "minimal" },
      }
    );
  }

  async delete(cacheKey: string | any[], key: string) {
    return await this.io.runTask(
      cacheKey,
      async (task) => {
        // FIXME: returning false from a task does not work as expected
        return await this.apiClient.store.delete(this.#namespacedKey(key));
      },
      {
        name: "Key-Value Store Delete",
        icon: "database-minus",
        params: { key },
        properties: this.#properties(key),
        style: { style: "minimal" },
      }
    );
  }
}
