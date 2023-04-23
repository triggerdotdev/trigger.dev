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
      scopeSeparator: string;
      /** Some APIs have strange urls, this allows total control to deal with that */
      createUrl?: (config: {
        authorizationUrl: string;
        clientId: string;
        clientSecret: string;
        key: string;
        callbackUrl: string;
        scopes: string[];
        scopeSeparator: string;
      }) => Promise<string>;
    };
    /** Token is how a token is obtained */
    token: {
      url: string;
      /** Some APIs have strange granting logic, this allows total control to deal with that */
      grantToken?: (config: {
        tokenUrl: string;
        clientId: string;
        clientSecret: string;
        code: string;
        callbackUrl: string;
        scopes: string[];
      }) => Promise<AccessToken>;
    };
    /** Refresh is how a token is refreshed */
    refresh: {
      url: string;
    };
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
  /** The param name of the scope, default is just "scope". Slack has "user" scopes that are a different query param */
  paramName?: string;
};

export type AccessToken = OAuth2AccessToken;

type OAuth2AccessToken = {
  type: "oauth2";
  access_token: string;
  scopes?: string[];
};
