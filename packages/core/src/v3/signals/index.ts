import { getGlobal, registerGlobal } from "../utils/globals.js";
import { NoopSignalsManager } from "./noopManager.js";
import type { SignalHandler, SignalsManager } from "./types.js";

const API_NAME = "signals";

const NOOP_MANAGER = new NoopSignalsManager();

export class SignalsAPI implements SignalsManager {
  private static _instance?: SignalsAPI;

  private constructor() {}

  public static getInstance(): SignalsAPI {
    if (!this._instance) {
      this._instance = new SignalsAPI();
    }
    return this._instance;
  }

  setGlobalManager(manager: SignalsManager): boolean {
    return registerGlobal(API_NAME, manager);
  }

  #getManager(): SignalsManager {
    return getGlobal(API_NAME) ?? NOOP_MANAGER;
  }

  public on(name: string, handler: SignalHandler): () => void {
    return this.#getManager().on(name, handler);
  }

  public reset(): void {
    this.#getManager().reset();
  }
}
