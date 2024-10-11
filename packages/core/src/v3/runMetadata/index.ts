import { DeserializedJson } from "../../schemas/json.js";
import { apiClientManager } from "../apiClientManager-api.js";
import { taskContext } from "../task-context-api.js";
import { getGlobal, registerGlobal } from "../utils/globals.js";
import { ApiRequestOptions } from "../zodfetch.js";

const API_NAME = "run-metadata";

export class RunMetadataAPI {
  private static _instance?: RunMetadataAPI;

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

  public async setKey(
    key: string,
    value: DeserializedJson,
    requestOptions?: ApiRequestOptions
  ): Promise<void> {
    const runId = taskContext.ctx?.run.id;

    if (!runId) {
      return;
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
  }

  public async deleteKey(key: string, requestOptions?: ApiRequestOptions): Promise<void> {
    const runId = taskContext.ctx?.run.id;

    if (!runId) {
      return;
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
  }

  public async update(
    metadata: Record<string, DeserializedJson>,
    requestOptions?: ApiRequestOptions
  ): Promise<void> {
    const runId = taskContext.ctx?.run.id;

    if (!runId) {
      return;
    }

    const apiClient = apiClientManager.clientOrThrow();

    const response = await apiClient.updateRunMetadata(runId, { metadata }, requestOptions);

    this.store = response.metadata;
  }
}
