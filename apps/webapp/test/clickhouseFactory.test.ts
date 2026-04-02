import { describe, expect } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { postgresTest } from "@internal/testcontainers";
import { OrganizationDataStoresRegistry } from "~/services/dataStores/organizationDataStoresRegistry.server";
import { ClickhouseConnectionSchema } from "~/services/clickhouse/clickhouseSecretSchemas.server";
import { ClickhouseFactory } from "~/services/clickhouse/clickhouseFactory.server";

vi.setConfig({ testTimeout: 60_000 });

const TEST_URL = "https://default:password@ch-org.example.com:8443";
const TEST_URL_2 = "https://default:password@ch-other.example.com:8443";

describe("ClickHouse Factory", () => {
  postgresTest(
    "returns default client when org has no data store",
    async ({ prisma }) => {
      const registry = new OrganizationDataStoresRegistry(prisma);
      await registry.loadFromDatabase();

      const factory = new ClickhouseFactory(registry);
      const client = await factory.getClickhouseForOrganization("org-no-store", "standard");
      expect(client).toBeDefined();
    }
  );

  postgresTest(
    "returns org-specific client when a data store is configured",
    async ({ prisma }) => {
      const registry = new OrganizationDataStoresRegistry(prisma);

      await registry.addDataStore({
        key: "factory-store",
        kind: "CLICKHOUSE",
        organizationIds: ["org-custom"],
        config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
      });

      await registry.loadFromDatabase();

      const factory = new ClickhouseFactory(registry);
      const client = await factory.getClickhouseForOrganization("org-custom", "standard");
      expect(client).toBeDefined();

      // Default client is a different instance from the org-specific one
      const defaultClient = await factory.getClickhouseForOrganization("org-no-store", "standard");
      expect(client).not.toBe(defaultClient);
    }
  );

  postgresTest(
    "two orgs sharing the same data store get the same cached client",
    async ({ prisma }) => {
      const registry = new OrganizationDataStoresRegistry(prisma);

      await registry.addDataStore({
        key: "shared-factory-store",
        kind: "CLICKHOUSE",
        organizationIds: ["org-shared-1", "org-shared-2"],
        config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
      });

      await registry.loadFromDatabase();

      const factory = new ClickhouseFactory(registry);
      const client1 = await factory.getClickhouseForOrganization("org-shared-1", "standard");
      const client2 = await factory.getClickhouseForOrganization("org-shared-2", "standard");

      // Same hostname → same cached client instance
      expect(client1).toBe(client2);
    }
  );

  postgresTest(
    "two data stores with different URLs produce different clients",
    async ({ prisma }) => {
      const registry = new OrganizationDataStoresRegistry(prisma);

      await registry.addDataStore({
        key: "store-a",
        kind: "CLICKHOUSE",
        organizationIds: ["org-a"],
        config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
      });

      await registry.addDataStore({
        key: "store-b",
        kind: "CLICKHOUSE",
        organizationIds: ["org-b"],
        config: ClickhouseConnectionSchema.parse({ url: TEST_URL_2 }),
      });

      await registry.loadFromDatabase();

      const factory = new ClickhouseFactory(registry);
      const clientA = await factory.getClickhouseForOrganization("org-a", "standard");
      const clientB = await factory.getClickhouseForOrganization("org-b", "standard");

      expect(clientA).not.toBe(clientB);
    }
  );

  postgresTest(
    "after reload with a deleted store, org falls back to default",
    async ({ prisma }) => {
      const registry = new OrganizationDataStoresRegistry(prisma);

      await registry.addDataStore({
        key: "removable-store",
        kind: "CLICKHOUSE",
        organizationIds: ["org-removable"],
        config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
      });

      await registry.loadFromDatabase();

      const factory = new ClickhouseFactory(registry);
      const before = await factory.getClickhouseForOrganization("org-removable", "standard");
      const defaultClient = await factory.getClickhouseForOrganization("org-no-store", "standard");
      expect(before).not.toBe(defaultClient);

      await registry.deleteDataStore({ key: "removable-store", kind: "CLICKHOUSE" });
      await registry.reload();

      const after = await factory.getClickhouseForOrganization("org-removable", "standard");
      expect(after).toBe(defaultClient);
    }
  );
});
