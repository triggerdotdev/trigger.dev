import { DeserializedJson } from "../../schemas/json.js";
import { getGlobal, registerGlobal } from "../utils/globals.js";
import { ApiRequestOptions } from "../zodfetch.js";
import { NoopRunMetadataManager } from "./noopManager.js";
import { RunMetadataManager } from "./types.js";

const API_NAME = "run-metadata";

const NOOP_MANAGER = new NoopRunMetadataManager();

export class RunMetadataAPI implements RunMetadataManager {
  private static _instance?: RunMetadataAPI;

  private constructor() {}

  public static getInstance(): RunMetadataAPI {
    if (!this._instance) {
      this._instance = new RunMetadataAPI();
    }

    return this._instance;
  }

  setGlobalManager(manager: RunMetadataManager): boolean {
    return registerGlobal(API_NAME, manager);
  }

  #getManager(): RunMetadataManager {
    return getGlobal(API_NAME) ?? NOOP_MANAGER;
  }

  public enterWithMetadata(metadata: Record<string, DeserializedJson>): void {
    this.#getManager().enterWithMetadata(metadata);
  }

  public current(): Record<string, DeserializedJson> | undefined {
    return this.#getManager().current();
  }

  public getKey(key: string): DeserializedJson | undefined {
    return this.#getManager().getKey(key);
  }

  public setKey(key: string, value: DeserializedJson) {
    return this.#getManager().setKey(key, value);
  }

  public deleteKey(key: string) {
    return this.#getManager().deleteKey(key);
  }

  public update(metadata: Record<string, DeserializedJson>): void {
    return this.#getManager().update(metadata);
  }

  flush(requestOptions?: ApiRequestOptions): Promise<void> {
    return this.#getManager().flush(requestOptions);
  }
}
