import type { APIConnection } from ".prisma/client";
import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { APIStore } from "./apiStore.server";
import { apiStore as apis } from "./apiStore.server";
import type { APIAuthenticationMethodOAuth2, ExternalAPI } from "./types";
import simpleOauth2 from "simple-oauth2";

const ConnectionMetadataSchema = z.object({
  account: z.string().optional(),
});

type ConnectionMetadata = z.infer<typeof ConnectionMetadataSchema>;

class APIAuthenticationRepository {
  #organizationId: string;
  #apiStore: APIStore;
  #prismaClient: PrismaClient;

  constructor(
    organizationId: string,
    apiStore: APIStore = apis,
    prismaClient: PrismaClient = prisma
  ) {
    this.#organizationId = organizationId;
    this.#apiStore = apiStore;
    this.#prismaClient = prismaClient;
  }

  /** Get all API connections for the organization */
  async getAllConnections() {
    const connections = await this.#prismaClient.aPIConnection.findMany({
      where: {
        organizationId: this.#organizationId,
      },
      select: {
        id: true,
        title: true,
        apiIdentifier: true,
        authenticationMethodKey: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return connections.map((c) => this.#enrichConnection(c));
  }

  /** Get all API connections for the organization, for a specific API */
  async getConnectionsForApi(api: ExternalAPI) {
    const connections = await this.#prismaClient.aPIConnection.findMany({
      where: {
        organizationId: this.#organizationId,
        apiIdentifier: api.identifier,
      },
      select: {
        id: true,
        title: true,
        apiIdentifier: true,
        authenticationMethodKey: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return connections.map((c) => this.#enrichConnection(c));
  }

  /** Get credentials for the given api and id */
  async createCredential(
    apiIdentifier: ExternalAPI,
    authenticationMethod: string
  ) {
    //todo create connection attempt
    //check the required environment variables exist
    //use the simple oauth client to redirect to the auth
    //return the info to start the redirect?
    //we need to come back afterwards
  }

  /** Get credentials for the given api and id */
  async getCredentials(api: ExternalAPI, connectionId: string) {
    //todo Prisma query for credentials for the given api and id
    //todo retrieve the credential from secret storage and the security provider
    //todo refresh the credential if needed
  }

  #enrichConnection(
    connection: Pick<
      APIConnection,
      | "id"
      | "title"
      | "apiIdentifier"
      | "authenticationMethodKey"
      | "metadata"
      | "createdAt"
      | "updatedAt"
    >
  ) {
    //parse the metadata into the desired format, fallback if needed
    const parsedMetadata = ConnectionMetadataSchema.safeParse(
      connection.metadata
    );
    let metadata: ConnectionMetadata = {};
    if (!parsedMetadata.success) {
      console.error(parsedMetadata.error.format());
      metadata = {};
    }

    //add details about the API and authentication method
    const api = this.#apiStore.getApi(connection.apiIdentifier);
    if (!api) {
      throw new Error(
        `API ${connection.apiIdentifier} not found for connection ${connection.id}`
      );
    }

    const authenticationMethod =
      api.authenticationMethods[connection.authenticationMethodKey];
    if (!authenticationMethod) {
      throw new Error(
        `API authentication method ${connection.authenticationMethodKey} not found for API ${connection.apiIdentifier} for connection ${connection.id}`
      );
    }

    return {
      ...connection,
      metadata,
      api: {
        identifier: api.identifier,
        name: api.name,
      },
      authenticationMethod: {
        type: authenticationMethod.type,
        possibleScopes: authenticationMethod.scopes,
      },
    };
  }
}

class OAuth2Client {
  #config: APIAuthenticationMethodOAuth2;
  //todo load the client id and secret from the environment
  constructor(config: APIAuthenticationMethodOAuth2) {
    this.#config = config;
  }

  createOAuthUrl({
    key,
    callbackUrl,
    scopes,
  }: {
    key: string;
    callbackUrl: string;
    scopes: string[];
  }) {
    //get the client id and secret from env vars
    const idEnvName = this.#config.client.id.envName;
    const clientId = process.env[idEnvName];
    if (!clientId) {
      throw new Error(`Client id environment variable not found: ${idEnvName}`);
    }
    const secretEnvName = this.#config.client.secret.envName;
    const clientSecret = process.env[secretEnvName];
    if (!clientSecret) {
      throw new Error(
        `Client secret environment variable not found: ${secretEnvName}`
      );
    }

    //for now we only support the "authorization_code" grantType
    if (this.#config.config.token.grantType !== "authorization_code") {
      throw new Error(
        `Unsupported grantType: ${this.#config.config.token.grantType}`
      );
    }

    //create the oauth2 client
    const authUrl = new URL(this.#config.config.authorization.url);
    const tokenUrl = new URL(this.#config.config.token.url);
    const refreshUrl = new URL(this.#config.config.refresh.url);
    const scopeSeparator =
      this.#config.config.authorization.scopeSeparator ?? " ";

    const clientConfig = {
      client: {
        id: clientId,
        idParamName: this.#config.client.id.paramName,
        secret: clientSecret,
        secretParamName: this.#config.client.secret.paramName,
      },
      auth: {
        authorizeHost: authUrl.host,
        authorizePath: authUrl.pathname,
        tokenHost: tokenUrl.host,
        tokenPath: tokenUrl.pathname,
        refreshPath: refreshUrl.pathname,
      },
      options: {
        scopeSeparator: scopeSeparator,
      },
    };

    const simpleOAuthClient = new simpleOauth2.AuthorizationCode(clientConfig);

    //create the authorization url
    const authorizationUri = simpleOAuthClient.authorizeURL({
      redirect_uri: callbackUrl,
      scope: scopes.join(scopeSeparator),
      state: key,
      ...additionalAuthParams,
    });
  }
}
