import type { DataStoreKind, PrismaClient, PrismaReplicaClient } from "@trigger.dev/database";
import {
  ClickhouseDataStoreConfig,
  type ParsedDataStore,
} from "./organizationDataStoreConfigSchemas.server";
import { getSecretStore } from "../secrets/secretStore.server";
import { ClickhouseConnectionSchema } from "../clickhouse/clickhouseSecretSchemas.server";

export class OrganizationDataStoresRegistry {
  /**
   * Writer client — used by every method that mutates state
   * (`addDataStore` / `updateDataStore` / `deleteDataStore` and their backing
   * SecretStore writes). Must be the primary connection; replica-targeted
   * writes are rejected by Postgres with code 25006 (read-only transaction).
   */
  private _writer: PrismaClient;
  /**
   * Read client used by the polling `loadFromDatabase()` (and its
   * `SecretStore.getSecret` lookups). Can be a replica — these are
   * cache-fillers, not on hot user-facing paths.
   */
  private _replica: PrismaClient | PrismaReplicaClient;
  /** Keyed by `${organizationId}:${kind}` */
  private _lookup: Map<string, ParsedDataStore> = new Map();
  private _loaded = false;
  private _readyResolve!: () => void;

  /**
   * Resolves once the initial `loadFromDatabase()` completes successfully.
   * At process startup the singleton loads the registry with unbounded retries
   * (exponential backoff, capped delay) until Postgres is reachable; until then
   * this promise stays pending and callers that await readiness will block.
   */
  readonly isReady: Promise<void>;

  constructor(writer: PrismaClient, replica: PrismaClient | PrismaReplicaClient) {
    this._writer = writer;
    this._replica = replica;
    this.isReady = new Promise<void>((resolve) => {
      this._readyResolve = resolve;
    });
  }

  get isLoaded(): boolean {
    return this._loaded;
  }

  async loadFromDatabase(): Promise<void> {
    // Sort by `key` (unique, immutable) to ensure a deterministic winner when the
    // same `${orgId}:${kind}` appears in multiple rows. The registry must never
    // throw on overlap — failing the load would break every customer, not just the
    // misconfigured orgs — so we keep the first entry and log an error instead.
    const rows = await this._replica.organizationDataStore.findMany({
      orderBy: { key: "asc" },
    });
    const secretStore = getSecretStore("DATABASE", { prismaClient: this._replica });

    const lookup = new Map<string, ParsedDataStore>();
    /** Tracks which row's `key` already owns each `${orgId}:${kind}` so we can log conflicts. */
    const winnerByLookupKey = new Map<string, string>();

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
        const lookupKey = `${orgId}:${row.kind}`;
        const existingWinner = winnerByLookupKey.get(lookupKey);
        if (existingWinner) {
          console.error(
            `[OrganizationDataStoresRegistry] Overlapping OrganizationDataStore assignment for orgId="${orgId}" kind=${row.kind}: already routed to "${existingWinner}", ignoring "${row.key}". Pick one store per (org, kind) to resolve.`
          );
          continue;
        }
        winnerByLookupKey.set(lookupKey, row.key);
        lookup.set(lookupKey, parsed);
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

    const secretStore = getSecretStore("DATABASE", { prismaClient: this._writer });
    await secretStore.setSecret(secretKey, config);

    return this._writer.organizationDataStore.create({
      data: {
        key,
        organizationIds,
        kind,
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
      const secretStore = getSecretStore("DATABASE", { prismaClient: this._writer });
      await secretStore.setSecret(secretKey, config);
    }

    return this._writer.organizationDataStore.update({
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
    const secretStore = getSecretStore("DATABASE", { prismaClient: this._writer });
    await secretStore.deleteSecret(secretKey).catch(() => {
      // Secret may not exist — proceed with deletion
    });

    await this._writer.organizationDataStore.delete({ where: { key } });
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
