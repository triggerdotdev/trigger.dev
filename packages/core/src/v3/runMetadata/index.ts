import { DeserializedJson } from "../../schemas/json.js";
import { apiClientManager } from "../apiClientManager-api.js";
import { taskContext } from "../task-context-api.js";
import { ApiRequestOptions } from "../zodfetch.js";

export class RunMetadataAPI {
  private static _instance?: RunMetadataAPI;
  private store: Record<string, DeserializedJson> | undefined;

  private constructor() {}

  public static getInstance(): RunMetadataAPI {
    if (!this._instance) {
      this._instance = new RunMetadataAPI();
    }

    return this._instance;
  }

  public enterWithMetadata(metadata: Record<string, DeserializedJson>): void {
    this.store = metadata;
  }

  public current(): Record<string, DeserializedJson> | undefined {
    return this.store;
  }

  public getKey(key: string): DeserializedJson | undefined {
    return this.store?.[key];
  }

  public async setKey(
    key: string,
    value: DeserializedJson,
    requestOptions?: ApiRequestOptions
  ): Promise<Record<string, DeserializedJson>> {
    const runId = taskContext.ctx?.run.id;

    if (!runId) {
      throw new Error("Cannot set metadata outside of a task run");
    }

    const apiClient = apiClientManager.clientOrThrow();

    const nextStore = {
      ...(this.store ?? {}),
      [key]: value,
    };

    const response = await apiClient.updateRunMetadata(
      runId,
      { metadata: nextStore },
      requestOptions
    );

    this.store = response.metadata;

    return this.store;
  }

  public async deleteKey(
    key: string,
    requestOptions?: ApiRequestOptions
  ): Promise<Record<string, DeserializedJson>> {
    const runId = taskContext.ctx?.run.id;

    if (!runId) {
      throw new Error("Cannot delete metadata outside of a task run");
    }

    const apiClient = apiClientManager.clientOrThrow();

    const nextStore = { ...(this.store ?? {}) };
    delete nextStore[key];

    const response = await apiClient.updateRunMetadata(
      runId,
      { metadata: nextStore },
      requestOptions
    );

    this.store = response.metadata;

    return this.store;
  }

  public async update(
    metadata: Record<string, DeserializedJson>,
    requestOptions?: ApiRequestOptions
  ): Promise<Record<string, DeserializedJson>> {
    const runId = taskContext.ctx?.run.id;

    if (!runId) {
      throw new Error("Cannot update metadata outside of a task run");
    }

    const apiClient = apiClientManager.clientOrThrow();

    const response = await apiClient.updateRunMetadata(runId, { metadata }, requestOptions);

    this.store = response.metadata;

    return this.store;
  }
}
