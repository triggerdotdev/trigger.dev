import { ApiClient } from "../apiClient";
import { readAuthConfigFile } from "./configFiles";

export function fetchPersonalAccessToken() {
  const config = readAuthConfigFile();

  return config?.accessToken;
}

export async function isLoggedIn(apiUrl: string) {
  const accessToken = fetchPersonalAccessToken();

  if (!accessToken) {
    return { ok: false, error: "You must login first" };
  }

  const apiClient = new ApiClient(apiUrl, accessToken);
  const userData = await apiClient.whoAmI();

  if (!userData.success) {
    return {
      ok: false,
      error: userData.error,
    };
  }

  return { ok: true, accessToken };
}
