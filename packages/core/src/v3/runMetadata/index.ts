import { DeserializedJson } from "../../schemas/json.js";
import { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import { getGlobal, registerGlobal } from "../utils/globals.js";
import { ApiRequestOptions } from "../zodfetch.js";
import { NoopRunMetadataManager } from "./noopManager.js";
import { RunMetadataManager, RunMetadataUpdater } from "./types.js";

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

  public set(key: string, value: DeserializedJson) {
    this.#getManager().set(key, value);
    return this;
  }

  public del(key: string) {
    this.#getManager().del(key);
    return this;
  }

  public increment(key: string, value: number) {
    this.#getManager().increment(key, value);
    return this;
  }

  decrement(key: string, value: number) {
    this.#getManager().decrement(key, value);
    return this;
  }

  append(key: string, value: DeserializedJson) {
    this.#getManager().append(key, value);
    return this;
  }

  remove(key: string, value: DeserializedJson) {
    this.#getManager().remove(key, value);
    return this;
  }

  public update(metadata: Record<string, DeserializedJson>) {
    this.#getManager().update(metadata);
    return this;
  }

  public stream<T>(
    key: string,
    value: AsyncIterable<T> | ReadableStream<T>,
    signal?: AbortSignal
  ): Promise<AsyncIterable<T>> {
    return this.#getManager().stream(key, value, signal);
  }

  public fetchStream<T>(key: string, signal?: AbortSignal): Promise<AsyncIterableStream<T>> {
    return this.#getManager().fetchStream(key, signal);
  }

  flush(requestOptions?: ApiRequestOptions): Promise<void> {
    return this.#getManager().flush(requestOptions);
  }

  refresh(requestOptions?: ApiRequestOptions): Promise<void> {
    return this.#getManager().refresh(requestOptions);
  }

  get parent(): RunMetadataUpdater {
    return this.#getManager().parent;
  }

  get root(): RunMetadataUpdater {
    return this.#getManager().root;
  }
}
