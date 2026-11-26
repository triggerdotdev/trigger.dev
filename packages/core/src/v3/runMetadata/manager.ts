import { dequal } from "dequal/lite";
import type { DeserializedJson } from "../../schemas/json.js";
import type { ApiClient } from "../apiClient/index.js";
import { realtimeStreams } from "../realtime-streams-api.js";
import type { RunMetadataChangeOperation } from "../schemas/common.js";
import type { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import type { IOPacket } from "../utils/ioSerialization.js";
import { stringifyIO } from "../utils/ioSerialization.js";
import type { ApiRequestOptions } from "../zodfetch.js";
import { applyMetadataOperations, collapseOperations } from "./operations.js";
import type { RunMetadataManager, RunMetadataUpdater } from "./types.js";

export class StandardMetadataManager implements RunMetadataManager {
  private flushTimeoutId: NodeJS.Timeout | null = null;
  /** The periodic flush that is running; a tick schedules the next only while it is still this one. */
  private periodicFlushRun: object | undefined;
  /** Set once the last flush has been handed to the run's completion: nothing is sent after it. */
  private flushingStopped: boolean = false;
  /** The update request being sent. At most one is in flight, so updates stay ordered. */
  private inFlightFlush: Promise<void> | undefined;
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

    this.stopPeriodicFlush();

    // The previous run's request settles on its own, against its own run id: it
    // isn't this run's, so this run's first flush sends at once. Its settling
    // leaves this run's in-flight request alone, and its response doesn't replace
    // this run's metadata (see `flush` and `#send`).
    this.inFlightFlush = undefined;
    // The previous run handed its last flush to its completion; this run flushes again.
    this.flushingStopped = false;
  }

  get parent(): RunMetadataUpdater {
    // Store a reference to 'this' to ensure proper context
    // eslint-disable-next-line no-this-alias
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
    // eslint-disable-next-line no-this-alias
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
    if (!this.runId) {
      throw new Error("Run ID is not set. fetchStream() can only be used inside a task.");
    }

    return await this.apiClient.fetchStream(this.runId, key, {
      signal,
      timeoutInSeconds: 60,
      lastEventId: undefined,
    });
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

    const streamInstance = realtimeStreams.pipe(key, value, {
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

  /**
   * Sends the queued changes and resolves when that request settles. When a
   * request is already in flight it returns at once and sends nothing, so
   * requests never overlap: what it leaves queued goes out with a later flush
   * once the in-flight request has settled, or with the run's completion
   * (`stopAndReturnLastFlush`) if the run ends first.
   */
  public flush(requestOptions?: ApiRequestOptions): Promise<void> {
    if (!this.runId || this.flushingStopped || !this.#needsFlush() || this.inFlightFlush) {
      return Promise.resolve();
    }

    const sending = this.#send(this.runId, requestOptions).finally(() => {
      if (this.inFlightFlush === sending) this.inFlightFlush = undefined;
    });
    this.inFlightFlush = sending;
    return sending;
  }

  async #send(runId: string, requestOptions?: ApiRequestOptions): Promise<void> {
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
        runId,
        {
          operations: collapsedOperations,
          parentOperations: collapsedParentOperations,
          rootOperations: collapsedRootOperations,
        },
        requestOptions
      );

      // A response to an earlier run's request (settling after a `reset()`) is
      // not this run's metadata.
      if (this.runId === runId) this.store = response.metadata;
    } catch (error) {
      console.error("Failed to flush metadata", error);
    }
  }

  public startPeriodicFlush(intervalMs: number = 1000) {
    const run = {};
    this.periodicFlushRun = run;

    const periodicFlush = async () => {
      try {
        // A tick that lands on an in-flight request returns at once; a later tick, or the run's
        // completion, sends what's left.
        await this.flush();
      } catch (error) {
        console.error("Failed to flush metadata", error);
      } finally {
        scheduleNext();
      }
    };

    const scheduleNext = () => {
      // Stopped (or restarted) while this tick was flushing: leave the timer alone.
      if (this.periodicFlushRun !== run) return;
      this.flushTimeoutId = setTimeout(periodicFlush, intervalMs);
    };

    scheduleNext();
  }

  stopPeriodicFlush(): void {
    this.periodicFlushRun = undefined;
    if (this.flushTimeoutId) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }
  }

  async stopAndReturnLastFlush(): Promise<IOPacket> {
    this.stopPeriodicFlush();
    this.flushingStopped = true;

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
