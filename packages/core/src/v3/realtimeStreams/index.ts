import { getGlobal, registerGlobal } from "../utils/globals.js";
import { NoopRealtimeStreamsManager } from "./noopManager.js";
import {
  RealtimePipeStreamOptions,
  RealtimeStreamInstance,
  RealtimeStreamsManager,
} from "./types.js";

const API_NAME = "realtime-streams";

const NOOP_MANAGER = new NoopRealtimeStreamsManager();

export class RealtimeStreamsAPI implements RealtimeStreamsManager {
  private static _instance?: RealtimeStreamsAPI;

  private constructor() {}

  public static getInstance(): RealtimeStreamsAPI {
    if (!this._instance) {
      this._instance = new RealtimeStreamsAPI();
    }

    return this._instance;
  }

  setGlobalManager(manager: RealtimeStreamsManager): boolean {
    return registerGlobal(API_NAME, manager);
  }

  #getManager(): RealtimeStreamsManager {
    return getGlobal(API_NAME) ?? NOOP_MANAGER;
  }

  public pipe<T>(
    key: string,
    source: AsyncIterable<T> | ReadableStream<T>,
    options?: RealtimePipeStreamOptions
  ): RealtimeStreamInstance<T> {
    return this.#getManager().pipe(key, source, options);
  }
}
