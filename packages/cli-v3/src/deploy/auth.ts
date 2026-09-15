import { CLOUD_API_URL, CLOUD_WEB_URL } from "../consts.js";
import { readAuthConfigProfile } from "../utilities/configFiles.js";
import type { LoginResult, LoginResultOk } from "../utilities/session.js";

const personalTokenPrefix = "tr_pat_";
const organizationTokenPrefix = "tr_oat_";
const apiKeyPrefix = "tr_";

export type DeployAuthorization =
  | LoginResultOk
  | {
      ok: true;
      profile: string;
      dashboardUrl: string;
      auth: {
        apiUrl: string;
        accessToken: string;
        tokenType: "apiKey";
      };
    };

type LoginForDeploy = (options: {
  embedded: true;
  defaultApiUrl: string;
  profile: string;
  silent: boolean;
}) => Promise<LoginResult>;

export async function authenticateForDeploy({
  accessToken,
  apiUrl,
  profile,
  silent,
  login,
}: {
  accessToken?: string;
  apiUrl?: string;
  profile: string;
  silent: boolean;
  login: LoginForDeploy;
}): Promise<LoginResult | DeployAuthorization> {
  const authConfig = readAuthConfigProfile(profile);
  const resolvedApiUrl = apiUrl ?? authConfig?.apiUrl ?? CLOUD_API_URL;

  const isApiKey =
    !!accessToken &&
    accessToken.startsWith(apiKeyPrefix) &&
    !accessToken.startsWith(personalTokenPrefix) &&
    !accessToken.startsWith(organizationTokenPrefix);

  if (!isApiKey) {
    return login({
      embedded: true,
      defaultApiUrl: resolvedApiUrl,
      profile,
      silent,
    });
  }

  return {
    ok: true,
    profile,
    dashboardUrl: dashboardUrlForApiUrl(resolvedApiUrl),
    auth: {
      apiUrl: resolvedApiUrl,
      accessToken,
      tokenType: "apiKey",
    },
  };
}

function dashboardUrlForApiUrl(apiUrl: string): string {
  if (apiUrl === CLOUD_API_URL) {
    return CLOUD_WEB_URL;
  }

  try {
    const url = new URL(apiUrl);
    if (url.hostname.startsWith("api.") && url.hostname.endsWith(".trigger.dev")) {
      url.hostname = url.hostname.slice(4);
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    throw new Error(
      `Invalid API URL "${apiUrl}". Check your TRIGGER_API_URL environment variable or --api-url flag.`
    );
  }

  return apiUrl;
}

export function userIdForDeploy(authorization: DeployAuthorization): string | undefined {
  return authorization.auth.tokenType === "personal" && "userId" in authorization
    ? authorization.userId
    : undefined;
}
