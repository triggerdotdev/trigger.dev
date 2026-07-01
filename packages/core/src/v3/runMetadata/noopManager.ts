import type { DeserializedJson } from "../../schemas/json.js";
import type { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import type { ApiRequestOptions } from "../zodfetch.js";
import type { RunMetadataManager, RunMetadataUpdater } from "./types.js";

export class NoopRunMetadataManager implements RunMetadataManager {
  append(_key: string, _value: DeserializedJson): this {
    throw new Error("Method not implemented.");
  }
  remove(_key: string, _value: DeserializedJson): this {
    throw new Error("Method not implemented.");
  }
  increment(_key: string, _value: number): this {
    throw new Error("Method not implemented.");
  }
  decrement(_key: string, _value: number): this {
    throw new Error("Method not implemented.");
  }
  stream<T>(_key: string, _value: AsyncIterable<T>): Promise<AsyncIterable<T>> {
    throw new Error("Method not implemented.");
  }
  fetchStream<T>(_key: string, _signal?: AbortSignal): Promise<AsyncIterableStream<T>> {
    throw new Error("Method not implemented.");
  }
  flush(_requestOptions?: ApiRequestOptions): Promise<void> {
    throw new Error("Method not implemented.");
  }
  refresh(_requestOptions?: ApiRequestOptions): Promise<void> {
    throw new Error("Method not implemented.");
  }
  enterWithMetadata(_metadata: Record<string, DeserializedJson>): void {}
  current(): Record<string, DeserializedJson> | undefined {
    throw new Error("Method not implemented.");
  }
  getKey(_key: string): DeserializedJson | undefined {
    throw new Error("Method not implemented.");
  }
  set(_key: string, _value: DeserializedJson): this {
    throw new Error("Method not implemented.");
  }
  del(_key: string): this {
    throw new Error("Method not implemented.");
  }
  update(_metadata: Record<string, DeserializedJson>): this {
    throw new Error("Method not implemented.");
  }

  get parent(): RunMetadataUpdater {
    // Store a reference to this object
    // eslint-disable-next-line no-this-alias no-unused-vars
    const self = this;

    // Create a local reference to ensure proper context
    const parentUpdater: RunMetadataUpdater = {
      append: () => parentUpdater,
      set: () => parentUpdater,
      del: () => parentUpdater,
      increment: () => parentUpdater,
      decrement: () => parentUpdater,
      remove: () => parentUpdater,
      stream: () =>
        Promise.resolve({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
      update: () => parentUpdater,
    };

    return parentUpdater;
  }

  get root(): RunMetadataUpdater {
    // Store a reference to this object
    // eslint-disable-next-line no-this-alias no-unused-vars
    const self = this;

    // Create a local reference to ensure proper context
    const rootUpdater: RunMetadataUpdater = {
      append: () => rootUpdater,
      set: () => rootUpdater,
      del: () => rootUpdater,
      increment: () => rootUpdater,
      decrement: () => rootUpdater,
      remove: () => rootUpdater,
      stream: () =>
        Promise.resolve({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
      update: () => rootUpdater,
    };

    return rootUpdater;
  }
}
