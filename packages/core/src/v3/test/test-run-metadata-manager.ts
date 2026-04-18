import type { DeserializedJson } from "../../schemas/json.js";
import type { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import type { RunMetadataManager, RunMetadataUpdater } from "../runMetadata/types.js";

/**
 * In-memory implementation of `RunMetadataManager` for unit tests.
 *
 * Just stores metadata in a Map — no API calls, no queue. Good enough
 * for tests that read/write metadata via `runMetadata.getKey()` /
 * `runMetadata.set()`, including the IDLE_TIMEOUT and TURN_TIMEOUT
 * checks inside `chat.agent()`.
 */
export class TestRunMetadataManager implements RunMetadataManager {
  private store: Record<string, DeserializedJson> = {};

  enterWithMetadata(metadata: Record<string, DeserializedJson>): void {
    this.store = { ...metadata };
  }

  current(): Record<string, DeserializedJson> | undefined {
    return { ...this.store };
  }

  getKey(key: string): DeserializedJson | undefined {
    return this.store[key];
  }

  set(key: string, value: DeserializedJson): this {
    this.store[key] = value;
    return this;
  }

  del(key: string): this {
    delete this.store[key];
    return this;
  }

  append(key: string, value: DeserializedJson): this {
    const existing = this.store[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      this.store[key] = [value];
    }
    return this;
  }

  remove(key: string, value: DeserializedJson): this {
    const existing = this.store[key];
    if (Array.isArray(existing)) {
      this.store[key] = existing.filter((v) => v !== value) as DeserializedJson;
    }
    return this;
  }

  increment(key: string, value: number): this {
    const existing = this.store[key];
    const current = typeof existing === "number" ? existing : 0;
    this.store[key] = current + value;
    return this;
  }

  decrement(key: string, value: number): this {
    return this.increment(key, -value);
  }

  update(metadata: Record<string, DeserializedJson>): this {
    this.store = { ...metadata };
    return this;
  }

  async flush(): Promise<void> {}
  async refresh(): Promise<void> {}

  async stream<T>(
    _key: string,
    value: AsyncIterable<T> | ReadableStream<T>
  ): Promise<AsyncIterable<T>> {
    return value as AsyncIterable<T>;
  }

  async fetchStream<T>(_key: string): Promise<AsyncIterableStream<T>> {
    // Return an empty async iterable — tests can override if needed
    const empty = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined as T }),
      }),
    };
    return empty as unknown as AsyncIterableStream<T>;
  }

  get parent(): RunMetadataUpdater {
    return this;
  }

  get root(): RunMetadataUpdater {
    return this;
  }

  reset(): void {
    this.store = {};
  }
}
