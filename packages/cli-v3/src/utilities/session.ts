import { ApiClient } from "../apiClient";
import { readAuthConfigFile } from "./configFiles";

export async function isLoggedIn() {
  const config = readAuthConfigFile();

  if (!config?.accessToken || !config?.apiUrl) {
    return { ok: false as const, error: "You must login first" };
  }

  const apiClient = new ApiClient(config.apiUrl, config.accessToken);
  const userData = await apiClient.whoAmI();

  if (!userData.success) {
    return {
      ok: false as const,
      error: userData.error,
    };
  }

  return {
    ok: true as const,
    config: {
      apiUrl: config.apiUrl,
      accessToken: config.accessToken,
    },
  };
}
