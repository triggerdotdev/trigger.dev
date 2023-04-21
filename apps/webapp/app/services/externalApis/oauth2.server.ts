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

  const clientConfig = {
    client: {
      id: clientId,
      secret: clientSecret,
    },
    auth: {
      authorizeHost: authUrl.host,
      authorizePath: authUrl.pathname,
      tokenHost: authUrl.host,
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
  scopes,
  scopeSeparator,
}: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  callbackUrl: string;
  scopes: string[];
  scopeSeparator: string;
}): Promise<AccessToken> {
  //create the oauth2 client
  const tokenUrlObj = new URL(tokenUrl);

  const clientConfig = {
    client: {
      id: clientId,
      secret: clientSecret,
    },
    auth: {
      tokenHost: tokenUrlObj.host,
      tokenPath: tokenUrlObj.pathname,
    },
  };

  const simpleOAuthClient = new simpleOauth2.AuthorizationCode(clientConfig);

  //create the authorization url
  const token = await simpleOAuthClient.getToken({
    code,
    redirect_uri: callbackUrl,
    scope: scopes.join(scopeSeparator),
  });

  if (typeof token.token.access_token !== "string") {
    throw new Error("Invalid access token");
  }

  let actualScopes = scopes;
  if (typeof token.token.scope === "string") {
    actualScopes = token.token.scope.split(scopeSeparator);
  }

  const accessToken: AccessToken = {
    type: "oauth2",
    access_token: token.token.access_token,
    scopes: actualScopes,
  };

  return accessToken;
}
