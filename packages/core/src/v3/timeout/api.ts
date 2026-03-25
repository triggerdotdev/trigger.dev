import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { TimeoutManager } from "./types.js";

const API_NAME = "timeout";

class NoopTimeoutManager implements TimeoutManager {
  abortAfterTimeout(timeoutInSeconds?: number): AbortController {
    return new AbortController();
  }

  reset() {}
}

const NOOP_TIMEOUT_MANAGER = new NoopTimeoutManager();

export class TimeoutAPI implements TimeoutManager {
  private static _instance?: TimeoutAPI;

  private constructor() {}

  public static getInstance(): TimeoutAPI {
    if (!this._instance) {
      this._instance = new TimeoutAPI();
    }

    return this._instance;
  }

  public get signal(): AbortSignal | undefined {
    return this.#getManager().signal;
  }

  public abortAfterTimeout(timeoutInSeconds?: number): AbortController {
    return this.#getManager().abortAfterTimeout(timeoutInSeconds);
  }

  public setGlobalManager(manager: TimeoutManager): boolean {
    return registerGlobal(API_NAME, manager);
  }

  public disable() {
    unregisterGlobal(API_NAME);
  }

  public reset() {
    this.#getManager().reset();
    this.disable();
  }

  public registerListener(listener: (timeoutInSeconds: number, elapsedTimeInSeconds: number) => void | Promise<void>) {
    const manager = this.#getManager();
    if (manager.registerListener) {
      manager.registerListener(listener);
    }
  }

  #getManager(): TimeoutManager {
    return getGlobal(API_NAME) ?? NOOP_TIMEOUT_MANAGER;
  }
}
