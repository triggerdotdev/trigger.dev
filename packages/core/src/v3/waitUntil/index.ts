import { getGlobal, registerGlobal } from "../utils/globals.js";
import { MaybeDeferredPromise, WaitUntilManager } from "./types.js";

const API_NAME = "wait-until";

class NoopManager implements WaitUntilManager {
  register(promise: MaybeDeferredPromise): void {
    // noop
  }

  blockUntilSettled(): Promise<void> {
    return Promise.resolve();
  }

  requiresResolving(): boolean {
    return false;
  }
}

const NOOP_MANAGER = new NoopManager();

export class WaitUntilAPI implements WaitUntilManager {
  private static _instance?: WaitUntilAPI;

  private constructor() {}

  public static getInstance(): WaitUntilAPI {
    if (!this._instance) {
      this._instance = new WaitUntilAPI();
    }

    return this._instance;
  }

  setGlobalManager(manager: WaitUntilManager): boolean {
    return registerGlobal(API_NAME, manager);
  }

  #getManager(): WaitUntilManager {
    return getGlobal(API_NAME) ?? NOOP_MANAGER;
  }

  register(promise: MaybeDeferredPromise): void {
    return this.#getManager().register(promise);
  }

  blockUntilSettled(): Promise<void> {
    return this.#getManager().blockUntilSettled();
  }

  requiresResolving(): boolean {
    return this.#getManager().requiresResolving();
  }
}
