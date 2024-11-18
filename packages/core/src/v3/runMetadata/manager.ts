import { JSONHeroPath } from "@jsonhero/path";
import { dequal } from "dequal/lite";
import { DeserializedJson } from "../../schemas/json.js";
import { ApiRequestOptions } from "../zodfetch.js";
import { RunMetadataManager } from "./types.js";
import { MetadataStream } from "./metadataStream.js";
import { ApiClient } from "../apiClient/index.js";

export class StandardMetadataManager implements RunMetadataManager {
  private flushTimeoutId: NodeJS.Timeout | null = null;
  private hasChanges: boolean = false;
  private store: Record<string, DeserializedJson> | undefined;
  // Add a Map to track active streams
  private activeStreams = new Map<string, MetadataStream<any>>();

  public runId: string | undefined;

  constructor(
    private apiClient: ApiClient,
    private streamsBaseUrl: string
  ) {}

  public enterWithMetadata(metadata: Record<string, DeserializedJson>): void {
    this.store = metadata ?? {};
  }

  public current(): Record<string, DeserializedJson> | undefined {
    return this.store;
  }

  public getKey(key: string): DeserializedJson | undefined {
    return this.store?.[key];
  }

  public setKey(key: string, value: DeserializedJson) {
    if (!this.runId) {
      return;
    }

    let nextStore: Record<string, DeserializedJson> | undefined = this.store
      ? structuredClone(this.store)
      : undefined;

    if (key.startsWith("$.")) {
      const path = new JSONHeroPath(key);
      path.set(nextStore, value);
    } else {
      nextStore = {
        ...(nextStore ?? {}),
        [key]: value,
      };
    }

    if (!nextStore) {
      return;
    }

    if (!dequal(this.store, nextStore)) {
      this.hasChanges = true;
    }

    this.store = nextStore;
  }

  public deleteKey(key: string) {
    if (!this.runId) {
      return;
    }

    const nextStore = { ...(this.store ?? {}) };
    delete nextStore[key];

    if (!dequal(this.store, nextStore)) {
      this.hasChanges = true;
    }

    this.store = nextStore;
  }

  public appendKey(key: string, value: DeserializedJson) {
    if (!this.runId) {
      return;
    }

    let nextStore: Record<string, DeserializedJson> | undefined = this.store
      ? structuredClone(this.store)
      : {};

    if (key.startsWith("$.")) {
      const path = new JSONHeroPath(key);
      const currentValue = path.first(nextStore);

      if (currentValue === undefined) {
        // Initialize as array with single item
        path.set(nextStore, [value]);
      } else if (Array.isArray(currentValue)) {
        // Append to existing array
        path.set(nextStore, [...currentValue, value]);
      } else {
        // Convert to array if not already
        path.set(nextStore, [currentValue, value]);
      }
    } else {
      const currentValue = nextStore[key];

      if (currentValue === undefined) {
        // Initialize as array with single item
        nextStore[key] = [value];
      } else if (Array.isArray(currentValue)) {
        // Append to existing array
        nextStore[key] = [...currentValue, value];
      } else {
        // Convert to array if not already
        nextStore[key] = [currentValue, value];
      }
    }

    if (!dequal(this.store, nextStore)) {
      this.hasChanges = true;
    }

    this.store = nextStore;
  }

  public incrementKey(key: string, increment: number = 1) {
    if (!this.runId) {
      return;
    }

    let nextStore = this.store ? structuredClone(this.store) : {};
    let currentValue = key.startsWith("$.")
      ? new JSONHeroPath(key).first(nextStore)
      : nextStore[key];

    const newValue = (typeof currentValue === "number" ? currentValue : 0) + increment;

    if (key.startsWith("$.")) {
      new JSONHeroPath(key).set(nextStore, newValue);
    } else {
      nextStore[key] = newValue;
    }

    if (!dequal(this.store, nextStore)) {
      this.hasChanges = true;
      this.store = nextStore;
    }
  }

  public decrementKey(key: string, decrement: number = 1) {
    this.incrementKey(key, -decrement);
  }

  public update(metadata: Record<string, DeserializedJson>): void {
    if (!this.runId) {
      return;
    }

    if (!dequal(this.store, metadata)) {
      this.hasChanges = true;
    }

    this.store = metadata;
  }

  public async stream<T>(
    key: string,
    value: AsyncIterable<T> | ReadableStream<T>,
    signal?: AbortSignal
  ): Promise<AsyncIterable<T>> {
    const $value = value as AsyncIterable<T>;

    if (!this.runId) {
      return $value;
    }

    try {
      // Add the key to the special stream metadata object
      this.setKey(`$$stream.${key}`, key);

      await this.flush();

      const streamInstance = new MetadataStream({
        key,
        runId: this.runId,
        iterator: $value[Symbol.asyncIterator](),
        baseUrl: this.streamsBaseUrl,
        signal,
      });

      this.activeStreams.set(key, streamInstance);

      // Clean up when stream completes
      streamInstance.wait().finally(() => this.activeStreams.delete(key));

      return streamInstance;
    } catch (error) {
      // Clean up metadata key if stream creation fails
      this.deleteKey(`$$stream.${key}`);
      throw error;
    }
  }

  public hasActiveStreams(): boolean {
    return this.activeStreams.size > 0;
  }

  // Waits for all the streams to finish
  public async waitForAllStreams(timeout: number = 30_000): Promise<void> {
    if (this.activeStreams.size === 0) {
      return;
    }

    const promises = Array.from(this.activeStreams.values());

    try {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve, _) => setTimeout(() => resolve(), timeout)),
      ]);
    } catch (error) {
      console.error("Error waiting for streams to finish:", error);

      // If we time out, abort all remaining streams
      for (const [key, promise] of this.activeStreams.entries()) {
        // We can add abort logic here if needed
        this.activeStreams.delete(key);
      }
      throw error;
    }
  }

  public async flush(requestOptions?: ApiRequestOptions): Promise<void> {
    if (!this.runId) {
      return;
    }

    if (!this.store) {
      return;
    }

    if (!this.hasChanges) {
      return;
    }

    try {
      this.hasChanges = false;
      await this.apiClient.updateRunMetadata(this.runId, { metadata: this.store }, requestOptions);
    } catch (error) {
      this.hasChanges = true;
      throw error;
    }
  }

  public startPeriodicFlush(intervalMs: number = 1000) {
    const periodicFlush = async (intervalMs: number) => {
      try {
        await this.flush();
      } catch (error) {
        console.error("Failed to flush metadata", error);
        throw error;
      } finally {
        scheduleNext();
      }
    };

    const scheduleNext = () => {
      this.flushTimeoutId = setTimeout(() => periodicFlush(intervalMs), intervalMs);
    };

    scheduleNext();
  }

  stopPeriodicFlush(): void {
    if (this.flushTimeoutId) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }
  }
}
