import { AsyncMap } from "@trigger.dev/core";
import { KeyValueStoreResponseBody } from "@trigger.dev/core";
import { Json } from "../io";

type QueryKeyValueStoreFunction = (
  action: "GET" | "SET" | "DELETE",
  data?: {
    key: string;
    value?: any;
  }
) => Promise<KeyValueStoreResponseBody>;

export class KeyValueStoreClient implements AsyncMap {
  constructor(
    private queryStore: QueryKeyValueStoreFunction,
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

  async get<T extends Json<T>>(key: string): Promise<T> {
    const result = await this.queryStore("GET", {
      key: this.#namespacedKey(key),
    });

    if (result.action !== "GET") {
      throw new Error("Unexpected key-value store response.");
    }

    return result.value;
  }

  async set<T extends Json<T>>(key: string, value: T): Promise<T> {
    const result = await this.queryStore("SET", {
      key: this.#namespacedKey(key),
      value,
    });

    if (result.action !== "SET") {
      throw new Error("Unexpected key-value store response.");
    }

    return result.value;
  }

  async delete(key: string) {
    const result = await this.queryStore("DELETE", {
      key: this.#namespacedKey(key),
    });

    if (result.action !== "DELETE") {
      throw new Error("Unexpected key-value store response.");
    }

    return result.deleted;
  }
}
