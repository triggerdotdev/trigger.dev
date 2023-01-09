import { githubProvider } from "./providers/github";
import { slackProvider } from "./providers/slack";
import { Provider, ProviderCatalog } from "./types";

export type {
  Provider,
  ProviderCatalog,
  APIKeyAuthentication,
  OAuthAuthentication,
} from "./types";

export function getProviders(isAdmin: boolean): Provider[] {
  return catalog.providers.filter((provider) => {
    switch (provider.enabledFor) {
      case "all":
        return true;
      case "admins":
        return isAdmin;
      case "none":
        return false;
    }
  });
}

const catalog: ProviderCatalog = {
  providers: [githubProvider, slackProvider],
};
