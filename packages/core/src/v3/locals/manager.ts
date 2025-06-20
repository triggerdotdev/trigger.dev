import { LocalsKey, LocalsManager } from "./types.js";

export class NoopLocalsManager implements LocalsManager {
  createLocal<T>(id: string): LocalsKey<T> {
    return {
      __type: Symbol(),
      id,
    } as unknown as LocalsKey<T>;
  }

  getLocal<T>(key: LocalsKey<T>): T | undefined {
    return undefined;
  }

  setLocal<T>(key: LocalsKey<T>, value: T): void {}
}

export class StandardLocalsManager implements LocalsManager {
  private store: Map<symbol, unknown> = new Map();

  createLocal<T>(id: string): LocalsKey<T> {
    const key = Symbol.for(id);
    return {
      __type: key,
      id,
    } as unknown as LocalsKey<T>;
  }

  getLocal<T>(key: LocalsKey<T>): T | undefined {
    return this.store.get(key.__type) as T | undefined;
  }

  setLocal<T>(key: LocalsKey<T>, value: T): void {
    this.store.set(key.__type, value);
  }

  reset(): void {
    this.store.clear();
  }
}
