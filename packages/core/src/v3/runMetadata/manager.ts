import { dequal } from "dequal/lite";
import { DeserializedJson } from "../../schemas/json.js";
import { ApiClient } from "../apiClient/index.js";
import { realtimeStreams } from "../realtime-streams-api.js";
import { RunMetadataChangeOperation } from "../schemas/common.js";
import { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import { IOPacket, stringifyIO } from "../utils/ioSerialization.js";
import { ApiRequestOptions } from "../zodfetch.js";
import { applyMetadataOperations, collapseOperations } from "./operations.js";
import type { RunMetadataManager, RunMetadataUpdater } from "./types.js";

export class StandardMetadataManager implements RunMetadataManager {
  private flushTimeoutId: NodeJS.Timeout | null = null;
  private isFlushing: boolean = false;
  private store: Record<string, DeserializedJson> | undefined;

  private queuedOperations: Set<RunMetadataChangeOperation> = new Set();
  private queuedParentOperations: Set<RunMetadataChangeOperation> = new Set();
  private queuedRootOperations: Set<RunMetadataChangeOperation> = new Set();

  public runId: string | undefined;
  public runIdIsRoot: boolean = false;

  constructor(private apiClient: ApiClient) {}

  reset(): void {
    this.queuedOperations.clear();
    this.queuedParentOperations.clear();
    this.queuedRootOperations.clear();
    this.store = undefined;
    this.runId = undefined;
    this.runIdIsRoot = false;

    if (this.flushTimeoutId) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }

    this.isFlushing = false;
  }

  get parent(): RunMetadataUpdater {
    // Store a reference to 'this' to ensure proper context
    const self = this;

    // Create the updater object and store it in a local variable
    const parentUpdater: RunMetadataUpdater = {
      set: (key, value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.set(key, value);
        }

        self.queuedParentOperations.add({ type: "set", key, value });
        return parentUpdater;
      },
      del: (key) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.del(key);
        }

        self.queuedParentOperations.add({ type: "delete", key });
        return parentUpdater;
      },
      append: (key, value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.append(key, value);
        }

        self.queuedParentOperations.add({ type: "append", key, value });
        return parentUpdater;
      },
      remove: (key, value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.remove(key, value);
        }

        self.queuedParentOperations.add({ type: "remove", key, value });
        return parentUpdater;
      },
      increment: (key, value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.increment(key, value);
        }

        self.queuedParentOperations.add({ type: "increment", key, value });
        return parentUpdater;
      },
      decrement: (key, value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.decrement(key, value);
        }

        self.queuedParentOperations.add({ type: "increment", key, value: -Math.abs(value) });
        return parentUpdater;
      },
      update: (value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.update(value);
        }

        self.queuedParentOperations.add({ type: "update", value });
        return parentUpdater;
      },
      stream: (key, value, signal) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.doStream(key, value, "self", parentUpdater, signal);
        }

        return self.doStream(key, value, "parent", parentUpdater, signal);
      },
    };

    return parentUpdater;
  }

  get root(): RunMetadataUpdater {
    // Store a reference to 'this' to ensure proper context
    const self = this;

    // Create the updater object and store it in a local variable
    const rootUpdater: RunMetadataUpdater = {
      set: (key, value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.set(key, value);
        }

        self.queuedRootOperations.add({ type: "set", key, value });
        return rootUpdater;
      },
      del: (key) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.del(key);
        }

        self.queuedRootOperations.add({ type: "delete", key });
        return rootUpdater;
      },
      append: (key, value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.append(key, value);
        }

        self.queuedRootOperations.add({ type: "append", key, value });
        return rootUpdater;
      },
      remove: (key, value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.remove(key, value);
        }

        self.queuedRootOperations.add({ type: "remove", key, value });
        return rootUpdater;
      },
      increment: (key, value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.increment(key, value);
        }

        self.queuedRootOperations.add({ type: "increment", key, value });
        return rootUpdater;
      },
      decrement: (key, value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.decrement(key, value);
        }

        self.queuedRootOperations.add({ type: "increment", key, value: -Math.abs(value) });
        return rootUpdater;
      },
      update: (value) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.update(value);
        }

        self.queuedRootOperations.add({ type: "update", value });
        return rootUpdater;
      },
      stream: (key, value, signal) => {
        // We have to check runIdIsRoot here because parent/root are executed before runIdIsRoot is set
        if (self.runIdIsRoot) {
          return self.doStream(key, value, "self", rootUpdater, signal);
        }

        return self.doStream(key, value, "root", rootUpdater, signal);
      },
    };

    return rootUpdater;
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
    return this.doStream(key, value, "self", this, signal);
  }

  public async fetchStream<T>(key: string, signal?: AbortSignal): Promise<AsyncIterableStream<T>> {
    throw new Error("This needs to use the new realtime streams API");
  }

  private async doStream<T>(
    key: string,
    value: AsyncIterable<T> | ReadableStream<T>,
    target: "self" | "parent" | "root",
    updater: RunMetadataUpdater = this,
    signal?: AbortSignal
  ): Promise<AsyncIterable<T>> {
    const $value = value as AsyncIterable<T>;

    if (!this.runId) {
      return $value;
    }

    const streamInstance = await realtimeStreams.append(key, value, {
      signal,
      target,
    });

    return streamInstance.stream;
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

    try {
      const collapsedOperations = collapseOperations(operations);
      const collapsedParentOperations = collapseOperations(parentOperations);
      const collapsedRootOperations = collapseOperations(rootOperations);

      const response = await this.apiClient.updateRunMetadata(
        this.runId,
        {
          operations: collapsedOperations,
          parentOperations: collapsedParentOperations,
          rootOperations: collapsedRootOperations,
        },
        requestOptions
      );

      this.store = response.metadata;
    } catch (error) {
      console.error("Failed to flush metadata", error);
    } finally {
      this.isFlushing = false;
    }
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

  async stopAndReturnLastFlush(): Promise<IOPacket> {
    this.stopPeriodicFlush();
    this.isFlushing = true;

    if (!this.#needsFlush()) {
      return { dataType: "application/json" };
    }

    const operations = Array.from(this.queuedOperations);
    const parentOperations = Array.from(this.queuedParentOperations);
    const rootOperations = Array.from(this.queuedRootOperations);

    const data = {
      operations: collapseOperations(operations),
      parentOperations: collapseOperations(parentOperations),
      rootOperations: collapseOperations(rootOperations),
    };

    const packet = await stringifyIO(data);

    return packet;
  }

  #needsFlush(): boolean {
    return (
      this.queuedOperations.size > 0 ||
      this.queuedParentOperations.size > 0 ||
      this.queuedRootOperations.size > 0
    );
  }
}
