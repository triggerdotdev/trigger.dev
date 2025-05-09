import { DeserializedJson } from "../../schemas/json.js";
import { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import { ApiRequestOptions } from "../zodfetch.js";
import type { RunMetadataManager, RunMetadataUpdater } from "./types.js";

export class NoopRunMetadataManager implements RunMetadataManager {
  append(key: string, value: DeserializedJson): this {
    throw new Error("Method not implemented.");
  }
  remove(key: string, value: DeserializedJson): this {
    throw new Error("Method not implemented.");
  }
  increment(key: string, value: number): this {
    throw new Error("Method not implemented.");
  }
  decrement(key: string, value: number): this {
    throw new Error("Method not implemented.");
  }
  stream<T>(key: string, value: AsyncIterable<T>): Promise<AsyncIterable<T>> {
    throw new Error("Method not implemented.");
  }
  fetchStream<T>(key: string, signal?: AbortSignal): Promise<AsyncIterableStream<T>> {
    throw new Error("Method not implemented.");
  }
  flush(requestOptions?: ApiRequestOptions): Promise<void> {
    throw new Error("Method not implemented.");
  }
  refresh(requestOptions?: ApiRequestOptions): Promise<void> {
    throw new Error("Method not implemented.");
  }
  enterWithMetadata(metadata: Record<string, DeserializedJson>): void {}
  current(): Record<string, DeserializedJson> | undefined {
    throw new Error("Method not implemented.");
  }
  getKey(key: string): DeserializedJson | undefined {
    throw new Error("Method not implemented.");
  }
  set(key: string, value: DeserializedJson): this {
    throw new Error("Method not implemented.");
  }
  del(key: string): this {
    throw new Error("Method not implemented.");
  }
  update(metadata: Record<string, DeserializedJson>): this {
    throw new Error("Method not implemented.");
  }

  get parent(): RunMetadataUpdater {
    // Store a reference to this object
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
