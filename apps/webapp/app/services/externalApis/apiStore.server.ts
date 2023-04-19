import { apis } from "./apiCatalog";
import type { ExternalAPI } from "./types";

/** Used to get External APIs */
export class APIStore {
  #apis: Record<string, ExternalAPI>;

  constructor(apis: Record<string, ExternalAPI>) {
    this.#apis = apis;
  }

  public getApis() {
    return this.#apis;
  }

  public getApi(identifier: string) {
    const api = this.#apis[identifier];
    if (!api) {
      return undefined;
    }
    return api;
  }
}

export const apiStore = new APIStore(apis);
