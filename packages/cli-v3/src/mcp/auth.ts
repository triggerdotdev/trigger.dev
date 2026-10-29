import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { env } from "std-env";
import { CliApiClient } from "../apiClient.js";
import { CLOUD_API_URL } from "../consts.js";
import { readAuthConfigProfile, writeAuthConfigProfile } from "../utilities/configFiles.js";
import { NotAccessTokenError, validateAccessToken } from "../utilities/accessTokens.js";
import type { LoginResult } from "../utilities/session.js";
import type { CreateAuthorizationCodeRequest } from "@trigger.dev/core/v3";
import {
  AUTHORIZATION_CODE_TTL_MS,
  exchangeApprovalCode,
  getPersonalAccessToken,
} from "../commands/login.js";
import {
  createPkcePair,
  listenForApprovalCallback,
  waitForApprovalCode,
} from "../utilities/loginApproval.js";
import open from "open";
import pRetry from "p-retry";
import type { McpContext } from "./context.js";

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
    const validationResult = validateAccessToken(accessTokenFromEnv);

    if (!validationResult.success) {
      // We deliberately don't surface the existence of organization access tokens to the user for now, as they're only used internally.
      // Once we expose them in the application, we should also communicate that option here.
      throw new NotAccessTokenError(
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
        tokenType: validationResult.type,
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
        tokenType: "personal" as const,
      },
    };
  }

  const apiClient = new CliApiClient(authConfig?.apiUrl ?? opts.defaultApiUrl);

  const callback = await listenForApprovalCallback("Return to your MCP client to continue.");

  let indexResult: { token: string; obfuscatedToken: string };

  try {
    const { codeVerifier, codeChallenge } = createPkcePair();
    const authorizationCodeResult = await createAuthorizationCode(apiClient, {
      codeChallenge,
      codeChallengeMethod: "S256",
      callbackPort: callback.port,
    });

    const url = new URL(authorizationCodeResult.url);

    url.searchParams.set("source", "mcp");

    const clientName = options.server.server.getClientVersion()?.name;

    if (clientName) {
      url.searchParams.set("clientName", clientName);
    }

    const allowLogin = await askForLoginPermission(opts.server, url.toString());

    if (!allowLogin) {
      return {
        ok: false as const,
        error: "User did not allow login",
      };
    }

    await open(url.toString());

    indexResult =
      authorizationCodeResult.approval === "callback"
        ? await exchangeApprovalCode(
            apiClient,
            { authorizationCode: authorizationCodeResult.authorizationCode, codeVerifier },
            await waitForApprovalCode(
              callback,
              AUTHORIZATION_CODE_TTL_MS,
              "Login timed out waiting for the browser to approve it. Try again, or log in from a terminal with `trigger.dev login --no-browser`."
            )
          )
        : await pRetry(
            () => getPersonalAccessToken(apiClient, authorizationCodeResult.authorizationCode),
            { factor: 1, retries: 300, minTimeout: 1000 }
          );
  } finally {
    callback.close();
  }

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
      tokenType: "personal" as const,
    },
  };
}

async function createAuthorizationCode(
  apiClient: CliApiClient,
  body: CreateAuthorizationCodeRequest
) {
  const authorizationCodeResult = await apiClient.createAuthorizationCode(body);

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
