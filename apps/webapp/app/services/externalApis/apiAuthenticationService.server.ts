import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { ExternalAPI } from "./types";

class APIAuthenticationService {
  #organizationId: string;
  #prismaClient: PrismaClient;

  constructor(organizationId: string, prismaClient: PrismaClient = prisma) {
    this.#organizationId = organizationId;
    this.#prismaClient = prismaClient;
  }

  /** Get all API connections for the organization */
  public async getConnections() {
    //todo Prisma query for all API connections for the organization
    this.#prismaClient.aPIConnection;
  }

  /** Get all API connections for the organization, for a specific API */
  public async getConnectionsForApi(api: ExternalAPI) {
    //todo Prisma query for all API connections for the organization, for a specific API
  }

  /** Get credentials for the given api and id */
  public async getCredentials(api: ExternalAPI, connectionId: string) {
    //todo Prisma query for credentials for the given api and id
    //todo retrieve the credential from secret storage and the security provider
    //todo refresh the credential if needed
  }
}
