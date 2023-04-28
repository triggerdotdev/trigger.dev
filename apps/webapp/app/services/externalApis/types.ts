import { z } from "zod";

export type ExternalAPI = {
  /** Used to uniquely identify an API */
  identifier: string;
  /** The name of the API */
  name: string;
  /** The possible authentication methods we support for this API  */
  authenticationMethods: Record<string, APIAuthenticationMethod>;
};

/** An authentication method that can be used */
export type APIAuthenticationMethod = APIAuthenticationMethodOAuth2;

export type AuthorizationLocation = "header" | "body";

export type CreateUrlParams = {
  authorizationUrl: string;
  clientId: string;
  clientSecret: string;
  key: string;
  callbackUrl: string;
  scopes: string[];
  scopeSeparator: string;
  pkceCode?: string;
  authorizationLocation: AuthorizationLocation;
  extraParameters?: Record<string, string>;
};

export type GrantTokenParams = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  callbackUrl: string;
  requestedScopes: string[];
  scopeSeparator: string;
  accessTokenKey: string;
  refreshTokenKey: string;
  expiresInKey: string;
  scopeKey: string;
  pkceCode?: string;
};

export type RefreshTokenParams = {
  refreshUrl: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  requestedScopes: string[];
  scopeSeparator: string;
  token: { accessToken: string; refreshToken: string; expiresAt: Date };
  accessTokenKey: string;
  refreshTokenKey: string;
  expiresInKey: string;
  scopeKey: string;
};

//A useful reference is the Simple OAuth2 npm library: https://github.com/lelylan/simple-oauth2/blob/HEAD/API.md#options
export type APIAuthenticationMethodOAuth2 = {
  /** The displayable name of the authentication method */
  name: string;
  /** The type of authentication method */
  type: "oauth2";
  /** Client configuration */
  client: {
    id: {
      /** The ENV var to get the id from */
      envName: string;
      /** The param name to use to send the client id, default to "client_id" */
      paramName?: string;
    };
    secret: {
      /** The ENV var to get the secret from */
      envName: string;
      /** The param name to use to send the client secret, default to "client_secret" */
      paramName?: string;
    };
  };
  config: {
    /** Authorization is used to generate an OAuth url for the user to do */
    authorization: {
      url: string;
      /** The string that is used to separate the scopes, usually a space or comma */
      scopeSeparator: string;
      /** The param name of the scope, default is just "scope". Slack has "user" scopes that are a different query param */
      scopeParamName?: string;
      /** The location of the authorization header, default is "body" */
      authorizationLocation?: AuthorizationLocation;
      /** Additional parameters to send to the authorization url */
      extraParameters?: Record<string, string>;
      /** Some APIs have strange urls, this allows total control to deal with that */
      createUrl?: (config: CreateUrlParams) => Promise<string>;
    };
    /** Token is how a token is obtained */
    token: {
      url: string;
      /** How to fetch the metadata from the token */
      metadata: {
        /** JSONPointer to the owner info in the raw token response */
        accountPointer?: string;
      };
      /** The access_token key in the token. Default to "/access_token" */
      accessTokenPointer?: string;
      /** The refresh_token key in the token. Default to "/refresh_token" */
      refreshTokenPointer?: string;
      /** The expires_in key in the token. Default to "/expires_in" */
      expiresInPointer?: string;
      /** The scope key in the token. Default to "/scope" */
      scopePointer?: string;
      /** Some APIs have strange granting logic, this allows total control to deal with that */
      grantToken?: (config: GrantTokenParams) => Promise<AccessToken>;
    };
    /** Refresh is how a token is refreshed */
    refresh: {
      url: string;
      /** Some APIs have strange refreshing logic, this allows total control to deal with that */
      refreshToken?: (config: RefreshTokenParams) => Promise<AccessToken>;
    };
    /** Proof Key of Code Exchange (PKCE) is an extension of the standard authorization code grant OAuth flow. Defaults to true */
    pkce?: boolean;
    /** The ENV var to get the app hostname from, defaults to APP_ORIGIN */
    appHostEnvName?: string;
  };
  /** Additional fields that are needed, e.g. Shopify requires a store name */
  additionalFields?: AdditionalField[];
  /** The possible scopes this auth method supports */
  scopes: Scope[];
};

type AdditionalField = {
  /** The name of the field */
  name: string;
  /** The key of the field, should be unique */
  key: string;
  /** The type of the field */
  type: "text" | "password";
};

type Scope = {
  /** The name of the scope */
  name: string;
  /** Description */
  description?: string;
  /** Default state of the checkbox. If unspecified it's false */
  defaultChecked?: boolean;
  /** Optional annotation that can appear next to the option  */
  annotations?: ScopeAnnotation[];
};

export type ScopeAnnotation = {
  label: string;
  color: string;
};

const OAuth2AccessTokenSchema = z.object({
  type: z.literal("oauth2"),
  accessToken: z.string(),
  expiresIn: z.number().optional(),
  refreshToken: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  raw: z.record(z.any()),
});

export const AccessTokenSchema = OAuth2AccessTokenSchema;
export type AccessToken = z.infer<typeof AccessTokenSchema>;

export const ConnectionMetadataSchema = z.object({
  account: z.string().optional(),
});

export type ConnectionMetadata = z.infer<typeof ConnectionMetadataSchema>;
