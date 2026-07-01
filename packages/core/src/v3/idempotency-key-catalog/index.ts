const API_NAME = "idempotency-key-catalog";

import { getGlobal, registerGlobal } from "../utils/globals.js";
import type { IdempotencyKeyCatalog, IdempotencyKeyOptions } from "./catalog.js";
import { InMemoryIdempotencyKeyCatalog } from "./inMemoryIdempotencyKeyCatalog.js";

export class IdempotencyKeyCatalogAPI {
  private static _instance?: IdempotencyKeyCatalogAPI;

  private constructor() {}

  public static getInstance(): IdempotencyKeyCatalogAPI {
    if (!this._instance) {
      this._instance = new IdempotencyKeyCatalogAPI();
    }
    return this._instance;
  }

  public registerKeyOptions(hash: string, options: IdempotencyKeyOptions): void {
    this.#getCatalog().registerKeyOptions(hash, options);
  }

  public getKeyOptions(hash: string): IdempotencyKeyOptions | undefined {
    return this.#getCatalog().getKeyOptions(hash);
  }

  public clear(): void {
    this.#getCatalog().clear();
  }

  #getCatalog(): IdempotencyKeyCatalog {
    let catalog = getGlobal(API_NAME);
    if (!catalog) {
      // Auto-initialize on first access
      catalog = new InMemoryIdempotencyKeyCatalog();
      registerGlobal(API_NAME, catalog, true);
    }
    return catalog;
  }
}
