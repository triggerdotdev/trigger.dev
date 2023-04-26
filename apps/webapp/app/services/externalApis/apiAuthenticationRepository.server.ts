import type { APIConnection } from ".prisma/client";
import jsonpointer from "jsonpointer";
import { nanoid } from "nanoid";
import * as crypto from "node:crypto";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { SecretStore } from "../secrets/secretStore.server";
import type { APIStore } from "./apiStore";
import { apiStore as apis } from "./apiStore";
import {
  createOAuth2Url,
  getClientConfigFromEnv,
  grantOAuth2Token,
} from "./oauth2.server";
import type { ConnectionMetadata, ExternalAPI } from "./types";
import { ConnectionMetadataSchema } from "./types";

export class APIAuthenticationRepository {
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
        scopes: true,
      },
      orderBy: {
        title: "asc",
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
        scopes: true,
      },
    });

    return connections.map((c) => this.#enrichConnection(c));
  }

  async createConnectionAttempt({
    apiIdentifier,
    authenticationMethodKey,
    scopes,
    title,
    redirectTo,
  }: {
    apiIdentifier: string;
    authenticationMethodKey: string;
    scopes: string[];
    title: string;
    redirectTo: string;
  }) {
    const api = this.#apiStore.getApi(apiIdentifier);
    if (!api) {
      throw new Error(`API ${apiIdentifier} not found`);
    }

    const authenticationMethod =
      api.authenticationMethods[authenticationMethodKey];
    if (!authenticationMethod) {
      throw new Error(
        `API authentication method ${authenticationMethodKey} not found for API ${apiIdentifier}`
      );
    }

    switch (authenticationMethod.type) {
      case "oauth2": {
        let pkceCode: string | undefined = undefined;
        if (authenticationMethod.config.pkce !== false) {
          pkceCode = crypto.randomBytes(24).toString("hex");
        }

        //create a connection attempt
        const connectionAttempt =
          await this.#prismaClient.aPIConnectionAttempt.create({
            data: {
              organizationId: this.#organizationId,
              apiIdentifier,
              authenticationMethodKey,
              scopes,
              title,
              redirectTo,
              securityCode: pkceCode,
            },
          });

        //create a url for the oauth2 flow
        const getClientConfig = getClientConfigFromEnv(
          authenticationMethod.client.id.envName,
          authenticationMethod.client.secret.envName
        );
        const callbackHostName = authenticationMethod.config.appHostEnvName
          ? process.env[authenticationMethod.config.appHostEnvName]
          : env.APP_ORIGIN;

        const createAuthorizationParams = {
          authorizationUrl: authenticationMethod.config.authorization.url,
          clientId: getClientConfig.id,
          clientSecret: getClientConfig.secret,
          key: connectionAttempt.id,
          callbackUrl: `${callbackHostName}/resources/connection/oauth2/callback`,
          scopes,
          scopeSeparator:
            authenticationMethod.config.authorization.scopeSeparator,
          pkceCode,
          authorizationLocation:
            authenticationMethod.config.authorization.authorizationLocation ??
            "body",
          extraParameters:
            authenticationMethod.config.authorization.extraParameters,
        };

        const authorizationUrl = await (authenticationMethod.config
          .authorization.createUrl
          ? authenticationMethod.config.authorization.createUrl(
              createAuthorizationParams
            )
          : createOAuth2Url(createAuthorizationParams));

        return authorizationUrl;
      }
      default: {
        throw new Error(
          `Authentication method type ${authenticationMethod.type} not supported`
        );
      }
    }
  }

  async createConnection({
    apiIdentifier,
    authenticationMethodKey,
    scopes,
    code,
    title,
    pkceCode,
  }: {
    apiIdentifier: string;
    authenticationMethodKey: string;
    scopes: string[];
    code: string;
    title: string;
    pkceCode?: string;
  }) {
    const api = this.#apiStore.getApi(apiIdentifier);
    if (!api) {
      throw new Error(`API ${apiIdentifier} not found`);
    }

    const authenticationMethod =
      api.authenticationMethods[authenticationMethodKey];
    if (!authenticationMethod) {
      throw new Error(
        `API authentication method ${authenticationMethodKey} not found for API ${apiIdentifier}`
      );
    }

    switch (authenticationMethod.type) {
      case "oauth2": {
        //create a url for the oauth2 flow
        const getClientConfig = getClientConfigFromEnv(
          authenticationMethod.client.id.envName,
          authenticationMethod.client.secret.envName
        );
        const callbackHostName = authenticationMethod.config.appHostEnvName
          ? process.env[authenticationMethod.config.appHostEnvName]
          : env.APP_ORIGIN;

        const params = {
          tokenUrl: authenticationMethod.config.token.url,
          clientId: getClientConfig.id,
          clientSecret: getClientConfig.secret,
          code,
          callbackUrl: `${callbackHostName}/resources/connection/oauth2/callback`,
          requestedScopes: scopes,
          scopeSeparator:
            authenticationMethod.config.authorization.scopeSeparator,
          pkceCode,
        };
        const token = await (authenticationMethod.config.token.grantToken
          ? authenticationMethod.config.token.grantToken(params)
          : grantOAuth2Token(params));

        const secretReference = await this.#prismaClient.secretReference.create(
          {
            data: {
              key: `${
                this.#organizationId
              }-${apiIdentifier}-${authenticationMethodKey}-${nanoid()}`,
              provider: env.SECRET_STORE,
            },
          }
        );

        const secretStore = new SecretStore(env.SECRET_STORE);
        await secretStore.setSecret(secretReference.key, token);

        //get metadata from the raw token
        const metadata: ConnectionMetadata = {};
        if (authenticationMethod.config.token.metadata.accountPointer) {
          const accountPointer = jsonpointer.compile(
            authenticationMethod.config.token.metadata.accountPointer
          );
          const account = accountPointer.get(token.raw);
          if (typeof account === "string") {
            metadata.account = account;
          }
        }

        const connection = this.#prismaClient.aPIConnection.create({
          data: {
            organizationId: this.#organizationId,
            apiIdentifier,
            authenticationMethodKey,
            metadata,
            title,
            dataReferenceId: secretReference.id,
            scopes: token.scopes,
          },
        });

        return connection;
      }
    }
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
      | "scopes"
    >
  ) {
    //parse the metadata into the desired format, fallback if needed
    const parsedMetadata = ConnectionMetadataSchema.safeParse(
      connection.metadata
    );
    let metadata: ConnectionMetadata = {};
    if (parsedMetadata.success) {
      metadata = parsedMetadata.data;
    } else {
      console.warn(
        `Connection ${
          connection.id
        } has invalid metadata, falling back to empty metadata.\n${parsedMetadata.error.format()}`
      );
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
