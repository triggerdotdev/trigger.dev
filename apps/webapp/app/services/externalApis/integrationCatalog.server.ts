import { github } from "./integrations/github";
import { openai } from "./integrations/openai";
import { plain } from "./integrations/plain";
import { resend } from "./integrations/resend";
import { slack } from "./integrations/slack";
import { stripe } from "./integrations/stripe";
import { supabaseManagement, supabase } from "./integrations/supabase";
import { typeform } from "./integrations/typeform";
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
  github,
  openai,
  plain,
  resend,
  slack,
  typeform,
  stripe,
  supabaseManagement,
  supabase,
});
