import { airtable } from "./providers/airtable";
import { github } from "./providers/github";
import { resend } from "./providers/resend";
import { shopify } from "./providers/shopify";
import { slack } from "./providers/slack";
import type { Provider, SerializableProvider } from "./types";

export type {
  APIKeyAuthentication,
  OAuthAuthentication,
  Provider,
  SerializableProvider,
} from "./types";
export { airtable, github, resend, slack, shopify };

const providerCatalog = {
  providers: { airtable, github, resend, slack, shopify },
};

export function getProviders(isAdmin: boolean): Array<SerializableProvider> {
  const providers = Object.values(providerCatalog.providers);
  const foundProviders = providers.filter((provider) => {
    switch (provider.enabledFor) {
      case "all":
        return true;
      case "admins":
        return isAdmin;
      case "none":
        return false;
      default:
        return false;
    }
  }) as Provider[];

  return foundProviders.map((provider) => omit(provider, ["schemas"]));
}

export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result: any = {};

  for (const key of Object.keys(obj)) {
    if (!keys.includes(key as K)) {
      result[key] = obj[key];
    }
  }

  return result;
}
