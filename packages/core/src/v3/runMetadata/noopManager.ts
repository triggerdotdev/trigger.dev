import { DeserializedJson } from "../../schemas/json.js";
import { AsyncIterableStream } from "../apiClient/stream.js";
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
    return {
      append: () => this.parent,
      set: () => this.parent,
      del: () => this.parent,
      increment: () => this.parent,
      decrement: () => this.parent,
      remove: () => this.parent,
      stream: () =>
        Promise.resolve({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
      update: () => this.parent,
    };
  }

  get root(): RunMetadataUpdater {
    return {
      append: () => this.root,
      set: () => this.root,
      del: () => this.root,
      increment: () => this.root,
      decrement: () => this.root,
      remove: () => this.root,
      stream: () =>
        Promise.resolve({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
      update: () => this.root,
    };
  }
}
