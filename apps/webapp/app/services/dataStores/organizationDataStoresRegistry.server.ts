import type { PrismaClient, PrismaReplicaClient } from "@trigger.dev/database";
import {
  ClickhouseDataStoreConfig,
  type ParsedDataStore,
} from "./organizationDataStoreConfigSchemas.server";

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
          parsed = { kind: "CLICKHOUSE", config: result.data };
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

  /**
   * Returns the parsed data store config for the given organization and kind,
   * or `null` if no override is configured (caller should use the default).
   */
  get(organizationId: string, kind: "CLICKHOUSE"): ParsedDataStore | null {
    if (!this._loaded) return null;
    return this._lookup.get(`${organizationId}:${kind}`) ?? null;
  }
}
