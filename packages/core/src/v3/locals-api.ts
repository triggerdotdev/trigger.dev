// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { LocalsAPI } from "./locals/index.js";
import type { LocalsKey } from "./locals/types.js";
/** Entrypoint for runtime API */
export const localsAPI = LocalsAPI.getInstance();

export const locals = {
  create<T>(id: string): LocalsKey<T> {
    return localsAPI.createLocal(id);
  },
  get<T>(key: LocalsKey<T>): T | undefined {
    return localsAPI.getLocal(key);
  },
  getOrThrow<T>(key: LocalsKey<T>): T {
    const value = localsAPI.getLocal(key);
    if (!value) {
      throw new Error(`Local with id ${key.id} not found`);
    }
    return value;
  },
  set<T>(key: LocalsKey<T>, value: T): T {
    localsAPI.setLocal(key, value);
    return value;
  },
};

export type Locals = typeof locals;
export type { LocalsKey };
