import { JSONHeroPath } from "@jsonhero/path";
import { dequal } from "dequal/lite";
import { DeserializedJson } from "../../schemas/json.js";
import { apiClientManager } from "../apiClientManager-api.js";
import { taskContext } from "../task-context-api.js";
import { ApiRequestOptions } from "../zodfetch.js";
import { RunMetadataManager } from "./types.js";
import { MetadataStream } from "./metadataStream.js";

export class StandardMetadataManager implements RunMetadataManager {
  private flushTimeoutId: NodeJS.Timeout | null = null;
  private hasChanges: boolean = false;
  private store: Record<string, DeserializedJson> | undefined;
  // Add a Map to track active streams
  private activeStreams = new Map<string, MetadataStream<any>>();

  constructor(private streamsBaseUrl: string) {}

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
    const runId = taskContext.ctx?.run.id;

    if (!runId) {
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
    const runId = taskContext.ctx?.run.id;

    if (!runId) {
      return;
    }

    const nextStore = { ...(this.store ?? {}) };
    delete nextStore[key];

    if (!dequal(this.store, nextStore)) {
      this.hasChanges = true;
    }

    this.store = nextStore;
  }

  public update(metadata: Record<string, DeserializedJson>): void {
    const runId = taskContext.ctx?.run.id;

    if (!runId) {
      return;
    }

    if (!dequal(this.store, metadata)) {
      this.hasChanges = true;
    }

    this.store = metadata;
  }

  public async stream<T>(
    key: string,
    value: AsyncIterable<T>,
    signal?: AbortSignal
  ): Promise<AsyncIterable<T>> {
    const runId = taskContext.ctx?.run.id;

    if (!runId) {
      return value;
    }

    // Add the key to the special stream metadata object
    this.setKey(`$$stream.${key}`, key);

    await this.flush();

    const streamInstance = new MetadataStream({
      key,
      runId,
      iterator: value[Symbol.asyncIterator](),
      baseUrl: this.streamsBaseUrl,
      signal,
    });

    this.activeStreams.set(key, streamInstance);

    // Clean up when stream completes
    streamInstance.wait().finally(() => this.activeStreams.delete(key));

    return streamInstance;
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
    const runId = taskContext.ctx?.run.id;

    if (!runId) {
      return;
    }

    if (!this.store) {
      return;
    }

    if (!this.hasChanges) {
      return;
    }

    const apiClient = apiClientManager.clientOrThrow();

    try {
      this.hasChanges = false;
      await apiClient.updateRunMetadata(runId, { metadata: this.store }, requestOptions);
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
