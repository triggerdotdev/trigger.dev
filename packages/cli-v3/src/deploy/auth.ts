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
  const authConfig = readAuthConfigProfile(profile);
  const resolvedApiUrl = apiUrl ?? authConfig?.apiUrl ?? CLOUD_API_URL;

  if (!secretKey) {
    return login({
      embedded: true,
      defaultApiUrl: resolvedApiUrl,
      profile,
      silent,
    });
  }

  if (secretKey.startsWith(personalTokenPrefix) || secretKey.startsWith(organizationTokenPrefix)) {
    return {
      ok: false,
      error: `TRIGGER_SECRET_KEY is set to a ${
        secretKey.startsWith(personalTokenPrefix) ? "Personal" : "Organization"
      } Access Token. Use TRIGGER_ACCESS_TOKEN instead, or remove TRIGGER_SECRET_KEY and use \`trigger login\`.`,
    };
  }

  if (!secretKey.startsWith(apiKeyPrefix)) {
    return {
      ok: false,
      error:
        "TRIGGER_SECRET_KEY does not look like a Trigger.dev API key. API keys start with \`tr_\` (e.g. \`tr_prod_...\`).",
    };
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
