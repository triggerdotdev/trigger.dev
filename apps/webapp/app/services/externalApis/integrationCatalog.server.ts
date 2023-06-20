import { airtable } from "./integrations/airtable";
import { github } from "./integrations/github";
import { openai } from "./integrations/openai";
import { slack } from "./integrations/slack";
import type { Integration } from "./types";

export class IntegrationCatalog {
  #integrations: Record<string, Integration>;

  constructor(integrations: Record<string, Integration>) {
    this.#integrations = integrations;
  }

  public getIntegrations() {
    return this.#integrations;
  }

  public getIntegration(identifier: string) {
    const api = this.#integrations[identifier];
    if (!api) {
      return undefined;
    }
    return api;
  }
}

export const integrationCatalog = new IntegrationCatalog({
  airtable,
  github,
  openai,
  slack,
});
