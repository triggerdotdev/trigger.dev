import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { env } from "std-env";
import { CliApiClient } from "../apiClient.js";
import { CLOUD_API_URL } from "../consts.js";
import { readAuthConfigProfile, writeAuthConfigProfile } from "../utilities/configFiles.js";
import {
  isPersonalAccessToken,
  NotPersonalAccessTokenError,
} from "../utilities/isPersonalAccessToken.js";
import { LoginResult, LoginResultOk } from "../utilities/session.js";
import { getPersonalAccessToken } from "../commands/login.js";
import open from "open";
import pRetry from "p-retry";
import { McpContext } from "./context.js";
import { ApiClient } from "@trigger.dev/core/v3";

export type McpAuthOptions = {
  server: McpServer;
  context: McpContext;
  defaultApiUrl?: string;
  profile?: string;
};

export async function mcpAuth(options: McpAuthOptions): Promise<LoginResult> {
  const opts = {
    defaultApiUrl: CLOUD_API_URL,
    ...options,
  };

  const accessTokenFromEnv = env.TRIGGER_ACCESS_TOKEN;

  if (accessTokenFromEnv) {
    if (!isPersonalAccessToken(accessTokenFromEnv)) {
      throw new NotPersonalAccessTokenError(
        "Your TRIGGER_ACCESS_TOKEN is not a Personal Access Token, they start with 'tr_pat_'. You can generate one here: https://cloud.trigger.dev/account/tokens"
      );
    }

    const auth = {
      accessToken: accessTokenFromEnv,
      apiUrl: env.TRIGGER_API_URL ?? opts.defaultApiUrl ?? CLOUD_API_URL,
    };

    const apiClient = new CliApiClient(auth.apiUrl, auth.accessToken);
    const userData = await apiClient.whoAmI();

    if (!userData.success) {
      throw new Error(userData.error);
    }

    return {
      ok: true as const,
      profile: options?.profile ?? "default",
      userId: userData.data.userId,
      email: userData.data.email,
      dashboardUrl: userData.data.dashboardUrl,
      auth: {
        accessToken: auth.accessToken,
        apiUrl: auth.apiUrl,
      },
    };
  }

  const authConfig = readAuthConfigProfile(options?.profile);

  if (authConfig && authConfig.accessToken) {
    const apiClient = new CliApiClient(
      authConfig.apiUrl ?? opts.defaultApiUrl,
      authConfig.accessToken
    );
    const userData = await apiClient.whoAmI();

    if (!userData.success) {
      throw new Error(userData.error);
    }

    return {
      ok: true as const,
      profile: options?.profile ?? "default",
      userId: userData.data.userId,
      email: userData.data.email,
      dashboardUrl: userData.data.dashboardUrl,
      auth: {
        accessToken: authConfig.accessToken,
        apiUrl: authConfig.apiUrl ?? opts.defaultApiUrl,
      },
    };
  }

  const apiClient = new CliApiClient(authConfig?.apiUrl ?? opts.defaultApiUrl);

  //generate authorization code
  const authorizationCodeResult = await createAuthorizationCode(apiClient);

  const url = new URL(authorizationCodeResult.url);

  url.searchParams.set("source", "mcp");

  const clientName = options.server.server.getClientVersion()?.name;

  if (clientName) {
    url.searchParams.set("clientName", clientName);
  }
  // Only elicitInput if the client has the elicitation capability

  // Elicit the user to visit the authorization code URL
  const allowLogin = await askForLoginPermission(opts.server, url.toString());

  if (!allowLogin) {
    return {
      ok: false as const,
      error: "User did not allow login",
    };
  }

  // Open the authorization code URL in the browser
  await open(url.toString());

  // Poll for the personal access token
  const indexResult = await pRetry(
    () => getPersonalAccessToken(apiClient, authorizationCodeResult.authorizationCode),
    {
      //this means we're polling, same distance between each attempt
      factor: 1,
      retries: 60,
      minTimeout: 1000,
    }
  );

  writeAuthConfigProfile(
    { accessToken: indexResult.token, apiUrl: opts.defaultApiUrl },
    options?.profile
  );

  const client = new CliApiClient(opts.defaultApiUrl, indexResult.token);
  const userData = await client.whoAmI();

  if (!userData.success) {
    throw new Error(userData.error);
  }

  return {
    ok: true as const,
    profile: options?.profile ?? "default",
    userId: userData.data.userId,
    email: userData.data.email,
    dashboardUrl: userData.data.dashboardUrl,
    auth: {
      accessToken: indexResult.token,
      apiUrl: opts.defaultApiUrl,
    },
  };
}

async function createAuthorizationCode(apiClient: CliApiClient) {
  const authorizationCodeResult = await apiClient.createAuthorizationCode();

  if (!authorizationCodeResult.success) {
    throw new Error(`Failed to create authorization code\n${authorizationCodeResult.error}`);
  }

  return authorizationCodeResult.data;
}

async function askForLoginPermission(server: McpServer, authorizationCodeUrl: string) {
  const capabilities = server.server.getClientCapabilities();

  if (typeof capabilities?.elicitation !== "object") {
    return true;
  }

  const result = await server.server.elicitInput({
    message: `You are not currently logged in. Would you like to login now? We'll automatically open the authorization code URL (${authorizationCodeUrl}) in your browser.`,
    requestedSchema: {
      type: "object",
      properties: {
        allowLogin: {
          type: "boolean",
          default: false,
          title: "Allow Login",
          description: "Whether to allow the user to login",
        },
      },
      required: ["allowLogin"],
    },
  });

  return result.action === "accept" && result.content?.allowLogin;
}

export async function createApiClientWithPublicJWT(
  auth: LoginResultOk,
  projectRef: string,
  envName: string,
  scopes: string[],
  previewBranch?: string
) {
  const cliApiClient = new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken, previewBranch);

  const jwt = await cliApiClient.getJWT(projectRef, envName, {
    claims: {
      scopes,
    },
  });

  if (!jwt.success) {
    return;
  }

  return new ApiClient(auth.auth.apiUrl, jwt.data.token);
}
