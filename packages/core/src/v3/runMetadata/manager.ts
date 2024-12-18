import { JSONHeroPath } from "@jsonhero/path";
import { dequal } from "dequal/lite";
import { DeserializedJson } from "../../schemas/json.js";
import { ApiRequestOptions } from "../zodfetch.js";
import { RunMetadataManager, RunMetadataUpdater } from "./types.js";
import { MetadataStream } from "./metadataStream.js";
import { ApiClient } from "../apiClient/index.js";
import { FlushedRunMetadata, RunMetadataChangeOperation } from "../schemas/common.js";
import { applyMetadataOperations } from "./operations.js";

const MAXIMUM_ACTIVE_STREAMS = 5;
const MAXIMUM_TOTAL_STREAMS = 10;

export class StandardMetadataManager implements RunMetadataManager {
  private flushTimeoutId: NodeJS.Timeout | null = null;
  private isFlushing: boolean = false;
  private store: Record<string, DeserializedJson> | undefined;
  // Add a Map to track active streams
  private activeStreams = new Map<string, MetadataStream<any>>();

  private queuedOperations: Set<RunMetadataChangeOperation> = new Set();
  private queuedParentOperations: Set<RunMetadataChangeOperation> = new Set();
  private queuedRootOperations: Set<RunMetadataChangeOperation> = new Set();

  public runId: string | undefined;

  constructor(
    private apiClient: ApiClient,
    private streamsBaseUrl: string,
    private streamsVersion: "v1" | "v2" = "v1"
  ) {}

  get parent(): RunMetadataUpdater {
    return {
      set: (key, value) => {
        this.queuedParentOperations.add({ type: "set", key, value });
        return this.parent;
      },
      del: (key) => {
        this.queuedParentOperations.add({ type: "delete", key });
        return this.parent;
      },
      append: (key, value) => {
        this.queuedParentOperations.add({ type: "append", key, value });
        return this.parent;
      },
      remove: (key, value) => {
        this.queuedParentOperations.add({ type: "remove", key, value });
        return this.parent;
      },
      increment: (key, value) => {
        this.queuedParentOperations.add({ type: "increment", key, value });
        return this.parent;
      },
      decrement: (key, value) => {
        this.queuedParentOperations.add({ type: "increment", key, value: -Math.abs(value) });
        return this.parent;
      },
      update: (value) => {
        this.queuedParentOperations.add({ type: "update", value });
        return this.parent;
      },
      stream: (key, value, signal) => this.doStream(key, value, this.parent, signal),
    };
  }

  get root(): RunMetadataUpdater {
    return {
      set: (key, value) => {
        this.queuedRootOperations.add({ type: "set", key, value });
        return this.root;
      },
      del: (key) => {
        this.queuedRootOperations.add({ type: "delete", key });
        return this.root;
      },
      append: (key, value) => {
        this.queuedRootOperations.add({ type: "append", key, value });
        return this.root;
      },
      remove: (key, value) => {
        this.queuedRootOperations.add({ type: "remove", key, value });
        return this.root;
      },
      increment: (key, value) => {
        this.queuedRootOperations.add({ type: "increment", key, value });
        return this.root;
      },
      decrement: (key, value) => {
        this.queuedRootOperations.add({ type: "increment", key, value: -Math.abs(value) });
        return this.root;
      },
      update: (value) => {
        this.queuedParentOperations.add({ type: "update", value });
        return this.root;
      },
      stream: (key, value, signal) => this.doStream(key, value, this.root, signal),
    };
  }

  public enterWithMetadata(metadata: Record<string, DeserializedJson>): void {
    this.store = metadata ?? {};
  }

  public current(): Record<string, DeserializedJson> | undefined {
    return this.store;
  }

  public getKey(key: string): DeserializedJson | undefined {
    return this.store?.[key];
  }

  private enqueueOperation(operation: RunMetadataChangeOperation) {
    const applyResults = applyMetadataOperations(this.store ?? {}, operation);

    if (applyResults.unappliedOperations.length > 0) {
      return;
    }

    if (dequal(this.store, applyResults.newMetadata)) {
      return;
    }

    this.queuedOperations.add(operation);
    this.store = applyResults.newMetadata as Record<string, DeserializedJson>;
  }

  public set(key: string, value: DeserializedJson) {
    if (!this.runId) {
      return this;
    }

    this.enqueueOperation({ type: "set", key, value });

    return this;
  }

  public del(key: string) {
    if (!this.runId) {
      return this;
    }

    this.enqueueOperation({ type: "delete", key });

    return this;
  }

  public append(key: string, value: DeserializedJson) {
    if (!this.runId) {
      return this;
    }

    this.enqueueOperation({ type: "append", key, value });

    return this;
  }

  public remove(key: string, value: DeserializedJson) {
    if (!this.runId) {
      return this;
    }

    this.enqueueOperation({ type: "remove", key, value });

    return this;
  }

  public increment(key: string, increment: number = 1) {
    if (!this.runId) {
      return this;
    }

    this.enqueueOperation({ type: "increment", key, value: increment });

    return this;
  }

  public decrement(key: string, decrement: number = 1) {
    return this.increment(key, -decrement);
  }

  public update(metadata: Record<string, DeserializedJson>) {
    if (!this.runId) {
      return this;
    }

    this.enqueueOperation({ type: "update", value: metadata });

    return this;
  }

  public async stream<T>(
    key: string,
    value: AsyncIterable<T> | ReadableStream<T>,
    signal?: AbortSignal
  ): Promise<AsyncIterable<T>> {
    return this.doStream(key, value, this, signal);
  }

  private async doStream<T>(
    key: string,
    value: AsyncIterable<T> | ReadableStream<T>,
    updater: RunMetadataUpdater = this,
    signal?: AbortSignal
  ): Promise<AsyncIterable<T>> {
    const $value = value as AsyncIterable<T>;

    if (!this.runId) {
      return $value;
    }

    // Check to make sure we haven't exceeded the max number of active streams
    if (this.activeStreams.size >= MAXIMUM_ACTIVE_STREAMS) {
      console.warn(
        `Exceeded the maximum number of active streams (${MAXIMUM_ACTIVE_STREAMS}). The "${key}" stream will be ignored.`
      );
      return $value;
    }

    // Check to make sure we haven't exceeded the max number of total streams
    const streams = (this.store?.$$streams ?? []) as string[];

    if (streams.length >= MAXIMUM_TOTAL_STREAMS) {
      console.warn(
        `Exceeded the maximum number of total streams (${MAXIMUM_TOTAL_STREAMS}). The "${key}" stream will be ignored.`
      );
      return $value;
    }

    try {
      const streamInstance = new MetadataStream({
        key,
        runId: this.runId,
        source: $value,
        baseUrl: this.streamsBaseUrl,
        headers: this.apiClient.getHeaders(),
        signal,
        version: this.streamsVersion,
      });

      this.activeStreams.set(key, streamInstance);

      // Clean up when stream completes
      streamInstance.wait().finally(() => this.activeStreams.delete(key));

      // Add the key to the special stream metadata object
      updater
        .append(`$$streams`, key)
        .set("$$streamsVersion", this.streamsVersion)
        .set("$$streamsBaseUrl", this.streamsBaseUrl);

      await this.flush();

      return streamInstance;
    } catch (error) {
      // Clean up metadata key if stream creation fails
      updater.remove(`$$streams`, key);
      throw error;
    }
  }

  public hasActiveStreams(): boolean {
    return this.activeStreams.size > 0;
  }

  // Waits for all the streams to finish
  public async waitForAllStreams(timeout: number = 60_000): Promise<void> {
    if (this.activeStreams.size === 0) {
      return;
    }

    const promises = Array.from(this.activeStreams.values()).map((stream) => stream.wait());

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

  public async refresh(requestOptions?: ApiRequestOptions): Promise<void> {
    if (!this.runId) {
      return;
    }

    try {
      const metadata = await this.apiClient.getRunMetadata(this.runId, requestOptions);
      this.store = metadata.metadata;
    } catch (error) {
      console.error("Failed to refresh metadata", error);
      throw error;
    }
  }

  public async flush(requestOptions?: ApiRequestOptions): Promise<void> {
    if (!this.runId) {
      return;
    }

    if (!this.#needsFlush()) {
      return;
    }

    if (this.isFlushing) {
      return;
    }

    this.isFlushing = true;

    const operations = Array.from(this.queuedOperations);
    this.queuedOperations.clear();

    const parentOperations = Array.from(this.queuedParentOperations);
    this.queuedParentOperations.clear();

    const rootOperations = Array.from(this.queuedRootOperations);
    this.queuedRootOperations.clear();

    const response = await this.apiClient.updateRunMetadata(
      this.runId,
      { operations, parentOperations, rootOperations },
      requestOptions
    );

    this.store = response.metadata;
  }

  public startPeriodicFlush(intervalMs: number = 1000) {
    const periodicFlush = async (intervalMs: number) => {
      if (this.isFlushing) {
        return;
      }

      try {
        await this.flush();
      } catch (error) {
        console.error("Failed to flush metadata", error);
        throw error;
      } finally {
        this.isFlushing = false;
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

  stopAndReturnLastFlush(): FlushedRunMetadata | undefined {
    this.stopPeriodicFlush();
    this.isFlushing = true;

    if (!this.#needsFlush()) {
      return;
    }

    return {
      operations: Array.from(this.queuedOperations),
      parentOperations: Array.from(this.queuedParentOperations),
      rootOperations: Array.from(this.queuedRootOperations),
    };
  }

  #needsFlush(): boolean {
    return (
      this.queuedOperations.size > 0 ||
      this.queuedParentOperations.size > 0 ||
      this.queuedRootOperations.size > 0
    );
  }
}
