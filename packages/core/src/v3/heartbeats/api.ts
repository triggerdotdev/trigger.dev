import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { HeartbeatsManager } from "./types.js";

const API_NAME = "heartbeats";

class NoopHeartbeatsManager implements HeartbeatsManager {
  startHeartbeat(id: string) {
    return;
  }

  stopHeartbeat() {
    return;
  }

  async yield() {
    return;
  }

  get lastHeartbeat(): Date | undefined {
    return undefined;
  }

  reset() {}
}

const NOOP_HEARTBEATS_MANAGER = new NoopHeartbeatsManager();

export class HeartbeatsAPI implements HeartbeatsManager {
  private static _instance?: HeartbeatsAPI;

  private constructor() {}

  public static getInstance(): HeartbeatsAPI {
    if (!this._instance) {
      this._instance = new HeartbeatsAPI();
    }

    return this._instance;
  }

  public setGlobalManager(manager: HeartbeatsManager): boolean {
    return registerGlobal(API_NAME, manager);
  }

  public disable() {
    unregisterGlobal(API_NAME);
  }

  public reset() {
    this.#getManager().reset();
    this.disable();
  }

  public get lastHeartbeat(): Date | undefined {
    return this.#getManager().lastHeartbeat;
  }

  public startHeartbeat(id: string) {
    return this.#getManager().startHeartbeat(id);
  }

  public stopHeartbeat() {
    return this.#getManager().stopHeartbeat();
  }

  public yield() {
    return this.#getManager().yield();
  }

  #getManager(): HeartbeatsManager {
    return getGlobal(API_NAME) ?? NOOP_HEARTBEATS_MANAGER;
  }
}
