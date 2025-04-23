import { DeserializedJson } from "../../schemas/json.js";
import { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import { ApiRequestOptions } from "../zodfetch.js";

export interface RunMetadataUpdater {
  set(key: string, value: DeserializedJson): this;
  del(key: string): this;
  append(key: string, value: DeserializedJson): this;
  remove(key: string, value: DeserializedJson): this;
  increment(key: string, value: number): this;
  decrement(key: string, value: number): this;
  update(metadata: Record<string, DeserializedJson>): this;
  stream<T>(
    key: string,
    value: AsyncIterable<T> | ReadableStream<T>,
    signal?: AbortSignal
  ): Promise<AsyncIterable<T>>;
}

export interface RunMetadataManager extends RunMetadataUpdater {
  // Instance Methods
  enterWithMetadata(metadata: Record<string, DeserializedJson>): void;
  current(): Record<string, DeserializedJson> | undefined;
  getKey(key: string): DeserializedJson | undefined;
  flush(requestOptions?: ApiRequestOptions): Promise<void>;
  refresh(requestOptions?: ApiRequestOptions): Promise<void>;
  fetchStream<T>(key: string, signal?: AbortSignal): Promise<AsyncIterableStream<T>>;

  get parent(): RunMetadataUpdater;
  get root(): RunMetadataUpdater;
}
