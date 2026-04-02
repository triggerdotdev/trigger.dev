import type { DataStoreKind, PrismaClient, PrismaReplicaClient } from "@trigger.dev/database";
import {
  ClickhouseDataStoreConfig,
  type ParsedDataStore,
} from "./organizationDataStoreConfigSchemas.server";
import { getSecretStore } from "../secrets/secretStore.server";
import { ClickhouseConnectionSchema } from "../clickhouse/clickhouseSecretSchemas.server";

export class OrganizationDataStoresRegistry {
  private _prisma: PrismaClient | PrismaReplicaClient;
  /** Keyed by `${organizationId}:${kind}` */
  private _lookup: Map<string, ParsedDataStore> = new Map();
  private _loaded = false;
  private _readyResolve!: () => void;

  /** Resolves once the initial `loadFromDatabase()` completes successfully. */
  readonly isReady: Promise<void>;

  constructor(prisma: PrismaClient | PrismaReplicaClient) {
    this._prisma = prisma;
    this.isReady = new Promise<void>((resolve) => {
      this._readyResolve = resolve;
    });
  }

  get isLoaded(): boolean {
    return this._loaded;
  }

  async loadFromDatabase(): Promise<void> {
    const rows = await this._prisma.organizationDataStore.findMany();
    const secretStore = getSecretStore("DATABASE", { prismaClient: this._prisma });

    const lookup = new Map<string, ParsedDataStore>();

    for (const row of rows) {
      let parsed: ParsedDataStore | null = null;

      switch (row.kind) {
        case "CLICKHOUSE": {
          const result = ClickhouseDataStoreConfig.safeParse(row.config);
          if (!result.success) {
            console.warn(
              `[OrganizationDataStoresRegistry] Invalid config for OrganizationDataStore "${row.key}" (kind=CLICKHOUSE): ${result.error.message}`
            );
            continue;
          }

          const connection = await secretStore.getSecret(
            ClickhouseConnectionSchema,
            result.data.data.secretKey
          );

          if (!connection) {
            console.warn(
              `[OrganizationDataStoresRegistry] Secret "${result.data.data.secretKey}" not found for OrganizationDataStore "${row.key}" — skipping`
            );
            continue;
          }

          parsed = { kind: "CLICKHOUSE", url: connection.url };
          break;
        }
        default: {
          console.warn(
            `[OrganizationDataStoresRegistry] Unknown kind "${row.kind}" for OrganizationDataStore "${row.key}" — skipping`
          );
          continue;
        }
      }

      for (const orgId of row.organizationIds) {
        const key = `${orgId}:${row.kind}`;
        lookup.set(key, parsed);
      }
    }

    this._lookup = lookup;

    if (!this._loaded) {
      this._loaded = true;
      this._readyResolve();
    }
  }

  async reload(): Promise<void> {
    await this.loadFromDatabase();
  }

  #secretKey(key: string, kind: DataStoreKind) {
    return `data-store:${key}:${kind.toLocaleLowerCase()}`;
  }

  async addDataStore({
    key,
    kind,
    organizationIds,
    config,
  }: {
    key: string;
    kind: DataStoreKind;
    organizationIds: string[];
    config: any;
  }) {
    const secretKey = this.#secretKey(key, kind);

    const secretStore = getSecretStore("DATABASE", { prismaClient: this._prisma });
    await secretStore.setSecret(secretKey, config);

    return this._prisma.organizationDataStore.create({
      data: {
        key,
        organizationIds,
        kind: "CLICKHOUSE",
        config: { version: 1, data: { secretKey } },
      },
    });
  }

  async updateDataStore({
    key,
    kind,
    organizationIds,
    config,
  }: {
    key: string;
    kind: DataStoreKind;
    organizationIds: string[];
    config?: any;
  }) {
    const secretKey = this.#secretKey(key, kind);

    if (config) {
      const secretStore = getSecretStore("DATABASE", { prismaClient: this._prisma });
      await secretStore.setSecret(secretKey, config);
    }

    return this._prisma.organizationDataStore.update({
      where: {
        key,
      },
      data: {
        organizationIds,
        kind: "CLICKHOUSE",
      },
    });
  }

  async deleteDataStore({ key, kind }: { key: string; kind: DataStoreKind }) {
    const secretKey = this.#secretKey(key, kind);
    const secretStore = getSecretStore("DATABASE", { prismaClient: this._prisma });
    await secretStore.deleteSecret(secretKey).catch(() => {
      // Secret may not exist — proceed with deletion
    });

    await this._prisma.organizationDataStore.delete({ where: { key } });
  }

  /**
   * Returns the parsed data store config for the given organization and kind,
   * or `null` if no override is configured (caller should use the default).
   */
  get(organizationId: string, kind: DataStoreKind): ParsedDataStore | null {
    if (!this._loaded) return null;
    return this._lookup.get(`${organizationId}:${kind}`) ?? null;
  }
}
