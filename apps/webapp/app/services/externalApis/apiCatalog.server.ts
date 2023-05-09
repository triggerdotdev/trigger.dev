import { airtable } from "./apis/airtable";
import { github } from "./apis/github";
import { slack } from "./apis/slack";
import type { ExternalApi } from "./types";

export class ApiCatalog {
  #apis: Record<string, ExternalApi>;

  constructor(apis: Record<string, ExternalApi>) {
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

export const apiCatalog = new ApiCatalog({ slack, airtable, github });
