import simpleOauth2 from "simple-oauth2";
import type { AccessToken } from "./types";

export function getClientConfigFromEnv(idName: string, secretName: string) {
  //get the client id and secret from env vars
  const id = process.env[idName];
  if (!id) {
    throw new Error(`Client id environment variable not found: ${idName}`);
  }

  const secret = process.env[secretName];
  if (!secret) {
    throw new Error(
      `Client secret environment variable not found: ${secretName}`
    );
  }

  return {
    id,
    secret,
  };
}

export async function createOAuth2Url({
  authorizationUrl,
  clientId,
  clientSecret,
  key,
  callbackUrl,
  scopes,
  scopeSeparator,
}: {
  authorizationUrl: string;
  clientId: string;
  clientSecret: string;
  key: string;
  callbackUrl: string;
  scopes: string[];
  scopeSeparator: string;
}): Promise<string> {
  //create the oauth2 client
  const authUrl = new URL(authorizationUrl);
  const authHost = `${authUrl.protocol}//${authUrl.host}`;

  const clientConfig = {
    client: {
      id: clientId,
      secret: clientSecret,
    },
    auth: {
      authorizeHost: authHost,
      authorizePath: authUrl.pathname,
      tokenHost: authHost,
    },
    options: {
      scopeSeparator,
    },
  };

  const simpleOAuthClient = new simpleOauth2.AuthorizationCode(clientConfig);

  //todo add security, i.e. PKCE.
  //some providers don't support this so it needs to be optional, default on

  //create the authorization url
  const authorizeUrl = simpleOAuthClient.authorizeURL({
    redirect_uri: callbackUrl,
    scope: scopes.join(scopeSeparator),
    state: key,
  });

  return authorizeUrl;
}

export async function grantOAuth2Token({
  tokenUrl,
  clientId,
  clientSecret,
  code,
  callbackUrl,
  requestedScopes,
  scopeSeparator,
  accessTokenKey = "access_token",
  refreshTokenKey = "refresh_token",
  expiresInKey = "expires_at",
  scopeKey = "scope",
}: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  callbackUrl: string;
  requestedScopes: string[];
  scopeSeparator: string;
  accessTokenKey?: string;
  refreshTokenKey?: string;
  expiresInKey?: string;
  scopeKey?: string;
}): Promise<AccessToken> {
  //create the oauth2 client
  const tokenUrlObj = new URL(tokenUrl);

  const clientConfig = {
    client: {
      id: clientId,
      secret: clientSecret,
    },
    auth: {
      tokenHost: `${tokenUrlObj.protocol}//${tokenUrlObj.host}`,
      tokenPath: tokenUrlObj.pathname,
    },
  };

  const simpleOAuthClient = new simpleOauth2.AuthorizationCode(clientConfig);

  //create the authorization url
  const token = await simpleOAuthClient.getToken({
    code,
    redirect_uri: callbackUrl,
    scope: requestedScopes.join(scopeSeparator),
  });

  const accessTokenValue = token.token[accessTokenKey];
  if (typeof accessTokenValue !== "string") {
    throw new Error("Invalid access token");
  }

  let actualScopes = requestedScopes;
  if (typeof token.token[scopeKey] === "string") {
    actualScopes = (token.token[scopeKey] as string).split(scopeSeparator);
  }

  const refreshToken = token.token[refreshTokenKey] as string | undefined;
  const expiresIn = token.token[expiresInKey] as number | undefined;

  const accessToken: AccessToken = {
    type: "oauth2",
    accessToken: accessTokenValue,
    refreshToken,
    expiresIn,
    scopes: actualScopes,
    raw: token.token,
  };

  return accessToken;
}
