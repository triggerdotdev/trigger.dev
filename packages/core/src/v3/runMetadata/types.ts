import { DeserializedJson } from "../../schemas/json.js";
import { ApiRequestOptions } from "../zodfetch.js";

export interface RunMetadataUpdater {
  setKey(key: string, value: DeserializedJson): void;
  deleteKey(key: string): void;
  appendKey(key: string, value: DeserializedJson): void;
  removeFromKey(key: string, value: DeserializedJson): void;
  incrementKey(key: string, value: number): void;
  decrementKey(key: string, value: number): void;
}

export interface RunMetadataManager extends RunMetadataUpdater {
  // Instance Methods
  enterWithMetadata(metadata: Record<string, DeserializedJson>): void;
  current(): Record<string, DeserializedJson> | undefined;
  getKey(key: string): DeserializedJson | undefined;
  update(metadata: Record<string, DeserializedJson>): void;
  flush(requestOptions?: ApiRequestOptions): Promise<void>;
  stream<T>(
    key: string,
    value: AsyncIterable<T> | ReadableStream<T>,
    signal?: AbortSignal
  ): Promise<AsyncIterable<T>>;
  get parent(): RunMetadataUpdater;
  get root(): RunMetadataUpdater;
}
