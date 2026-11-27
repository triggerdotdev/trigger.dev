import { env } from "std-env";
import { CliApiClient } from "../apiClient.js";
import { CLOUD_API_URL } from "../consts.js";
import { validateAccessToken } from "./accessTokens.js";
import { getKnownUser, knownUserGeneration, rememberUserId, type KnownUser } from "./knownUser.js";
import { isLoggedIn } from "./session.js";

// Reads the stored login only; it never starts a login flow or prompts.
export async function lookupUserId(options: {
  profile?: string;
  apiUrl?: string;
  signal?: AbortSignal;
}): Promise<KnownUser | undefined> {
  const known = getKnownUser();
  if (known) return known;
  const generation = knownUserGeneration();

  const token = env.TRIGGER_ACCESS_TOKEN;

  if (token) {
    if (!validateAccessToken(token).success) return undefined;
    const apiUrl = env.TRIGGER_API_URL ?? options.apiUrl ?? CLOUD_API_URL;
    const result = await new CliApiClient(apiUrl, token).whoAmI(undefined, options.signal);
    if (!result.success) return undefined;
    rememberUserId(result.data.userId, apiUrl, generation);
  } else {
    await isLoggedIn(options.profile, { signal: options.signal });
  }

  return getKnownUser();
}
