import { CLOUD_API_URL, CLOUD_WEB_URL } from "../consts.js";
import type { LoginResult, LoginResultOk } from "../utilities/session.js";

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
  secretKey,
  apiUrl,
  profile,
  silent,
  login,
}: {
  secretKey?: string;
  apiUrl?: string;
  profile: string;
  silent: boolean;
  login: LoginForDeploy;
}): Promise<LoginResult | DeployAuthorization> {
  const resolvedApiUrl = apiUrl ?? CLOUD_API_URL;

  if (!secretKey) {
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
      accessToken: secretKey,
      tokenType: "apiKey",
    },
  };
}

function dashboardUrlForApiUrl(apiUrl: string): string {
  if (apiUrl === CLOUD_API_URL) {
    return CLOUD_WEB_URL;
  }

  const url = new URL(apiUrl);
  if (url.hostname.startsWith("api.") && url.hostname.endsWith(".trigger.dev")) {
    url.hostname = url.hostname.slice(4);
    return url.toString().replace(/\/$/, "");
  }

  return apiUrl;
}

export function userIdForDeploy(authorization: DeployAuthorization): string | undefined {
  return authorization.auth.tokenType === "personal" && "userId" in authorization
    ? authorization.userId
    : undefined;
}
