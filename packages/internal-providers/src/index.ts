import { github } from "./providers/github";
import { slack } from "./providers/slack";
import { Provider } from "./types";

export type {
  Provider,
  APIKeyAuthentication,
  OAuthAuthentication,
} from "./types";

const providerCatalog = {
  providers: { github, slack },
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

export { github, slack };
