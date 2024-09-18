import { AsyncMap } from "@trigger.dev/core";
import { KeyValueStoreResponseBody } from "@trigger.dev/core";
import { JSONOutputSerializer, Json } from "../io.js";

type QueryKeyValueStoreFunction = (
  action: "DELETE" | "GET" | "HAS" | "SET",
  data: {
    key: string;
    value?: string;
  }
) => Promise<KeyValueStoreResponseBody>;

export class KeyValueStoreClient implements AsyncMap {
  #serializer = new JSONOutputSerializer();

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

  async delete(key: string): Promise<boolean> {
    const result = await this.queryStore("DELETE", {
      key: this.#namespacedKey(key),
    });

    if (result.action !== "DELETE") {
      throw new Error(`Unexpected key-value store response: ${result.action}`);
    }

    return result.deleted;
  }

  async get<T extends Json<T>>(key: string): Promise<T | undefined> {
    const result = await this.queryStore("GET", {
      key: this.#namespacedKey(key),
    });

    if (result.action !== "GET") {
      throw new Error(`Unexpected key-value store response: ${result.action}`);
    }

    return this.#serializer.deserialize(result.value);
  }

  async has(key: string): Promise<boolean> {
    const result = await this.queryStore("HAS", {
      key: this.#namespacedKey(key),
    });

    if (result.action !== "HAS") {
      throw new Error(`Unexpected key-value store response: ${result.action}`);
    }

    return result.has;
  }

  async set<T extends Json<T>>(key: string, value: T): Promise<T> {
    const result = await this.queryStore("SET", {
      key: this.#namespacedKey(key),
      value: this.#serializer.serialize(value),
    });

    if (result.action !== "SET") {
      throw new Error(`Unexpected key-value store response: ${result.action}`);
    }

    return this.#serializer.deserialize(result.value);
  }
}
