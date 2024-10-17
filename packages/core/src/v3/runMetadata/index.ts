import { dequal } from "dequal/lite";
import { DeserializedJson } from "../../schemas/json.js";
import { apiClientManager } from "../apiClientManager-api.js";
import { taskContext } from "../task-context-api.js";
import { getGlobal, registerGlobal } from "../utils/globals.js";
import { ApiRequestOptions } from "../zodfetch.js";
import { JSONHeroPath } from "@jsonhero/path";

const API_NAME = "run-metadata";

export class RunMetadataAPI {
  private static _instance?: RunMetadataAPI;
  private flushTimeoutId: NodeJS.Timeout | null = null;
  private hasChanges: boolean = false;

  private constructor() {}

  public static getInstance(): RunMetadataAPI {
    if (!this._instance) {
      this._instance = new RunMetadataAPI();
    }

    return this._instance;
  }

  get store(): Record<string, DeserializedJson> | undefined {
    return getGlobal(API_NAME);
  }

  set store(value: Record<string, DeserializedJson> | undefined) {
    registerGlobal(API_NAME, value, true);
  }

  public enterWithMetadata(metadata: Record<string, DeserializedJson>): void {
    registerGlobal(API_NAME, metadata);
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
