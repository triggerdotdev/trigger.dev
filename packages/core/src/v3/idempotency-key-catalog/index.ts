const API_NAME = "idempotency-key-catalog";

import { getGlobal, registerGlobal } from "../utils/globals.js";
import type { IdempotencyKeyCatalog, IdempotencyKeyOptions } from "./catalog.js";
import { LRUIdempotencyKeyCatalog } from "./lruIdempotencyKeyCatalog.js";

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

  #getCatalog(): IdempotencyKeyCatalog {
    let catalog = getGlobal(API_NAME);
    if (!catalog) {
      // Auto-initialize with LRU catalog on first access
      catalog = new LRUIdempotencyKeyCatalog();
      registerGlobal(API_NAME, catalog, true);
    }
    return catalog;
  }
}
