import { DeserializedJson } from "../../schemas/json.js";
import { ApiRequestOptions } from "../zodfetch.js";
import type { RunMetadataManager } from "./types.js";

export class NoopRunMetadataManager implements RunMetadataManager {
  stream<T>(key: string, value: AsyncIterable<T>): Promise<AsyncIterable<T>> {
    throw new Error("Method not implemented.");
  }
  flush(requestOptions?: ApiRequestOptions): Promise<void> {
    throw new Error("Method not implemented.");
  }
  enterWithMetadata(metadata: Record<string, DeserializedJson>): void {}
  current(): Record<string, DeserializedJson> | undefined {
    throw new Error("Method not implemented.");
  }
  getKey(key: string): DeserializedJson | undefined {
    throw new Error("Method not implemented.");
  }
  setKey(key: string, value: DeserializedJson): void {
    throw new Error("Method not implemented.");
  }
  deleteKey(key: string): void {
    throw new Error("Method not implemented.");
  }
  update(metadata: Record<string, DeserializedJson>): void {
    throw new Error("Method not implemented.");
  }
}
