import { describe, expect } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { postgresTest } from "@internal/testcontainers";
import { OrganizationDataStoresRegistry } from "~/services/dataStores/organizationDataStoresRegistry.server";
import { ClickhouseConnectionSchema } from "~/services/clickhouse/clickhouseSecretSchemas.server";

vi.setConfig({ testTimeout: 60_000 });

const TEST_URL = "https://default:password@clickhouse.example.com:8443";
const TEST_URL_2 = "https://default:password@clickhouse2.example.com:8443";

describe("OrganizationDataStoresRegistry", () => {
  postgresTest("isLoaded is false before loadFromDatabase", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);
    expect(registry.isLoaded).toBe(false);
    expect(registry.get("any-org", "CLICKHOUSE")).toBeNull();
  });

  postgresTest("isLoaded is true after loadFromDatabase", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);
    await registry.loadFromDatabase();
    expect(registry.isLoaded).toBe(true);
  });

  postgresTest("isReady resolves after loadFromDatabase", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);
    let resolved = false;
    registry.isReady.then(() => {
      resolved = true;
    });
    await registry.loadFromDatabase();
    await registry.isReady;
    expect(resolved).toBe(true);
  });

  postgresTest("get returns null when no data stores exist", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);
    await registry.loadFromDatabase();
    expect(registry.get("org-1", "CLICKHOUSE")).toBeNull();
  });

  postgresTest("addDataStore creates a row and stores the secret", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);

    await registry.addDataStore({
      key: "test-store",
      kind: "CLICKHOUSE",
      organizationIds: ["org-1", "org-2"],
      config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
    });

    const row = await prisma.organizationDataStore.findFirst({ where: { key: "test-store" } });
    expect(row).not.toBeNull();
    expect(row?.organizationIds).toEqual(["org-1", "org-2"]);
    expect(row?.kind).toBe("CLICKHOUSE");

    const secret = await prisma.secretStore.findFirst({
      where: { key: "data-store:test-store:clickhouse" },
    });
    expect(secret).not.toBeNull();
  });

  postgresTest("loadFromDatabase resolves secrets and makes orgs available via get", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);

    await registry.addDataStore({
      key: "hipaa-store",
      kind: "CLICKHOUSE",
      organizationIds: ["org-hipaa"],
      config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
    });

    await registry.loadFromDatabase();

    const result = registry.get("org-hipaa", "CLICKHOUSE");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("CLICKHOUSE");
    expect(result?.url).toBe(TEST_URL);
  });

  postgresTest("get returns null for orgs not in any data store", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);

    await registry.addDataStore({
      key: "partial-store",
      kind: "CLICKHOUSE",
      organizationIds: ["org-a"],
      config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
    });

    await registry.loadFromDatabase();

    expect(registry.get("org-a", "CLICKHOUSE")).not.toBeNull();
    expect(registry.get("org-b", "CLICKHOUSE")).toBeNull();
  });

  postgresTest("multiple orgs can share the same data store", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);

    await registry.addDataStore({
      key: "shared-store",
      kind: "CLICKHOUSE",
      organizationIds: ["org-x", "org-y", "org-z"],
      config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
    });

    await registry.loadFromDatabase();

    const x = registry.get("org-x", "CLICKHOUSE");
    const y = registry.get("org-y", "CLICKHOUSE");
    const z = registry.get("org-z", "CLICKHOUSE");

    expect(x?.url).toBe(TEST_URL);
    expect(y?.url).toBe(TEST_URL);
    expect(z?.url).toBe(TEST_URL);
  });

  postgresTest("updateDataStore updates organizationIds and rotates the secret", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);

    await registry.addDataStore({
      key: "update-store",
      kind: "CLICKHOUSE",
      organizationIds: ["org-old"],
      config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
    });

    await registry.updateDataStore({
      key: "update-store",
      kind: "CLICKHOUSE",
      organizationIds: ["org-new-1", "org-new-2"],
      config: ClickhouseConnectionSchema.parse({ url: TEST_URL_2 }),
    });

    const row = await prisma.organizationDataStore.findFirst({ where: { key: "update-store" } });
    expect(row?.organizationIds).toEqual(["org-new-1", "org-new-2"]);

    await registry.loadFromDatabase();
    expect(registry.get("org-new-1", "CLICKHOUSE")?.url).toBe(TEST_URL_2);
    expect(registry.get("org-old", "CLICKHOUSE")).toBeNull();
  });

  postgresTest("reload picks up changes made after initial load", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);
    await registry.loadFromDatabase();
    expect(registry.get("org-reload", "CLICKHOUSE")).toBeNull();

    await registry.addDataStore({
      key: "reload-store",
      kind: "CLICKHOUSE",
      organizationIds: ["org-reload"],
      config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
    });

    expect(registry.get("org-reload", "CLICKHOUSE")).toBeNull();

    await registry.reload();
    expect(registry.get("org-reload", "CLICKHOUSE")?.url).toBe(TEST_URL);
  });

  postgresTest("deleteDataStore removes the row and its secret", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);

    await registry.addDataStore({
      key: "delete-store",
      kind: "CLICKHOUSE",
      organizationIds: ["org-delete"],
      config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
    });

    await registry.deleteDataStore({ key: "delete-store", kind: "CLICKHOUSE" });

    expect(await prisma.organizationDataStore.findFirst({ where: { key: "delete-store" } })).toBeNull();
    expect(await prisma.secretStore.findFirst({ where: { key: "data-store:delete-store:clickhouse" } })).toBeNull();
  });

  postgresTest("after delete and reload, org no longer has a data store", async ({ prisma }) => {
    const registry = new OrganizationDataStoresRegistry(prisma);

    await registry.addDataStore({
      key: "ephemeral-store",
      kind: "CLICKHOUSE",
      organizationIds: ["org-ephemeral"],
      config: ClickhouseConnectionSchema.parse({ url: TEST_URL }),
    });

    await registry.loadFromDatabase();
    expect(registry.get("org-ephemeral", "CLICKHOUSE")?.url).toBe(TEST_URL);

    await registry.deleteDataStore({ key: "ephemeral-store", kind: "CLICKHOUSE" });
    await registry.reload();

    expect(registry.get("org-ephemeral", "CLICKHOUSE")).toBeNull();
  });
});
