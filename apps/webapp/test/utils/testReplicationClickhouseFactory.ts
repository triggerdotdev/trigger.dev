import type { ClickHouse } from "@internal/clickhouse";
import {
  ClickhouseFactory,
  type ClientType,
} from "~/services/clickhouse/clickhouseFactory.server";
import type { OrganizationDataStoresRegistry } from "~/services/dataStores/organizationDataStoresRegistry.server";

const testReplicationRegistryStub = {
  isLoaded: true,
  isReady: Promise.resolve(),
  get: () => null,
} as unknown as OrganizationDataStoresRegistry;

/**
 * Routes all `replication` clients to a single test ClickHouse; other client types use the real factory defaults.
 */
export class TestReplicationClickhouseFactory extends ClickhouseFactory {
  constructor(private readonly replicationClient: ClickHouse) {
    super(testReplicationRegistryStub);
  }

  override getClickhouseForOrganizationSync(
    organizationId: string,
    clientType: ClientType
  ): ClickHouse {
    if (clientType === "replication") {
      return this.replicationClient;
    }
    return super.getClickhouseForOrganizationSync(organizationId, clientType);
  }
}
