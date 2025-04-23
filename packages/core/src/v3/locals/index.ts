const API_NAME = "locals";

import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { NoopLocalsManager } from "./manager.js";
import { LocalsKey, type LocalsManager } from "./types.js";

const NOOP_LOCALS_MANAGER = new NoopLocalsManager();

export class LocalsAPI implements LocalsManager {
  private static _instance?: LocalsAPI;

  private constructor() {}

  public static getInstance(): LocalsAPI {
    if (!this._instance) {
      this._instance = new LocalsAPI();
    }

    return this._instance;
  }

  public setGlobalLocalsManager(localsManager: LocalsManager): boolean {
    return registerGlobal(API_NAME, localsManager);
  }

  public disable() {
    unregisterGlobal(API_NAME);
  }

  public createLocal<T>(id: string): LocalsKey<T> {
    return this.#getManager().createLocal(id);
  }

  public getLocal<T>(key: LocalsKey<T>): T | undefined {
    return this.#getManager().getLocal(key);
  }

  public setLocal<T>(key: LocalsKey<T>, value: T): void {
    return this.#getManager().setLocal(key, value);
  }

  #getManager(): LocalsManager {
    return getGlobal(API_NAME) ?? NOOP_LOCALS_MANAGER;
  }
}
