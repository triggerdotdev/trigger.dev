import { airtable } from "./providers/airtable";
import { github } from "./providers/github";
import { shopify } from "./providers/shopify";
import { slack } from "./providers/slack";
import { Provider } from "./types";

export type {
  APIKeyAuthentication,
  OAuthAuthentication,
  Provider,
} from "./types";
export { airtable, github, slack, shopify };

const providerCatalog = {
  providers: { airtable, github, slack, shopify },
};

export function getProviders(isAdmin: boolean): Provider[] {
  const providers = Object.values(providerCatalog.providers);
  return providers.filter((provider) => {
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
}
