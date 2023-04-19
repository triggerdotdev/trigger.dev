import { apis } from "./apiCatalog";

/** Used to get External APIs */
class APIStore {
  public getApis() {
    return apis;
  }

  public getApi(identifier: string) {
    const api = apis[identifier];
    if (!api) {
      return undefined;
    }
    return api;
  }
}

export const apiStore = new APIStore();
