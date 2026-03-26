import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "~/db.server";
import {
  getClickhouseForOrganization,
  getEventRepositoryForOrganization,
  clearClickhouseCacheForOrganization,
} from "./clickhouseFactory.server";
import {
  setOrganizationClickhouseUrl,
  removeOrganizationClickhouseUrl,
  getOrganizationClickhouseUrl,
} from "./clickhouseCredentialsService.server";

describe("ClickHouse Factory", () => {
  const testOrgId = "test-org-" + Date.now();
  const testClickhouseUrl = "https://test-ch.example.com:8443?user=test&password=secret";

  beforeEach(async () => {
    // Clean up any existing test data
    await prisma.organization.deleteMany({
      where: { id: testOrgId },
    });
  });

  it("should return default ClickHouse client when org has no custom config", async () => {
    const client = await getClickhouseForOrganization(testOrgId, "standard");
    expect(client).toBeDefined();
    // Default client should be returned (not null)
    expect(client).toBeTruthy();
  });

  it("should set and retrieve organization ClickHouse URL", async () => {
    // First create the test organization
    await prisma.organization.create({
      data: {
        id: testOrgId,
        title: "Test Org",
        slug: "test-org-" + Date.now(),
      },
    });

    // Set the URL
    await setOrganizationClickhouseUrl(testOrgId, "standard", testClickhouseUrl);

    // Retrieve it
    const retrievedUrl = await getOrganizationClickhouseUrl(testOrgId, "standard");
    expect(retrievedUrl).toBe(testClickhouseUrl);

    // Verify it's stored in featureFlags
    const org = await prisma.organization.findUnique({
      where: { id: testOrgId },
      select: { featureFlags: true },
    });

    expect(org?.featureFlags).toBeDefined();
    const featureFlags = org?.featureFlags as any;
    expect(featureFlags.clickhouse).toBeDefined();
    expect(featureFlags.clickhouse.standard).toBeDefined();

    // Clean up
    await removeOrganizationClickhouseUrl(testOrgId, "standard");
    await prisma.organization.delete({ where: { id: testOrgId } });
  });

  it("should remove organization ClickHouse URL", async () => {
    // First create the test organization
    await prisma.organization.create({
      data: {
        id: testOrgId,
        title: "Test Org",
        slug: "test-org-" + Date.now(),
      },
    });

    // Set and then remove
    await setOrganizationClickhouseUrl(testOrgId, "standard", testClickhouseUrl);
    await removeOrganizationClickhouseUrl(testOrgId, "standard");

    // Verify it's gone
    const retrievedUrl = await getOrganizationClickhouseUrl(testOrgId, "standard");
    expect(retrievedUrl).toBeNull();

    // Clean up
    await prisma.organization.delete({ where: { id: testOrgId } });
  });

  it("should cache ClickHouse clients by hostname", async () => {
    // This test verifies that multiple orgs pointing to the same ClickHouse hostname
    // share the same client instance (deduplication)

    const org1Id = testOrgId + "-1";
    const org2Id = testOrgId + "-2";

    // Create test organizations
    await prisma.organization.createMany({
      data: [
        { id: org1Id, title: "Test Org 1", slug: "test-org-1-" + Date.now() },
        { id: org2Id, title: "Test Org 2", slug: "test-org-2-" + Date.now() },
      ],
    });

    // Set both orgs to use the same ClickHouse URL
    await setOrganizationClickhouseUrl(org1Id, "standard", testClickhouseUrl);
    await setOrganizationClickhouseUrl(org2Id, "standard", testClickhouseUrl);

    // Get clients for both orgs
    const client1 = await getClickhouseForOrganization(org1Id, "standard");
    const client2 = await getClickhouseForOrganization(org2Id, "standard");

    // Both should be defined
    expect(client1).toBeDefined();
    expect(client2).toBeDefined();

    // They should be the same instance (cached by hostname)
    expect(client1).toBe(client2);

    // Clean up
    await removeOrganizationClickhouseUrl(org1Id, "standard");
    await removeOrganizationClickhouseUrl(org2Id, "standard");
    await prisma.organization.deleteMany({
      where: { id: { in: [org1Id, org2Id] } },
    });
  });

  it("should clear cache when organization config changes", async () => {
    // Create test organization
    await prisma.organization.create({
      data: {
        id: testOrgId,
        title: "Test Org",
        slug: "test-org-" + Date.now(),
      },
    });

    // Set URL
    await setOrganizationClickhouseUrl(testOrgId, "standard", testClickhouseUrl);

    // Get client to populate cache
    const client1 = await getClickhouseForOrganization(testOrgId, "standard");

    // Clear cache
    clearClickhouseCacheForOrganization(testOrgId);

    // Get client again (should hit the database again, not cache)
    const client2 = await getClickhouseForOrganization(testOrgId, "standard");

    // Both should be defined
    expect(client1).toBeDefined();
    expect(client2).toBeDefined();

    // Clean up
    await removeOrganizationClickhouseUrl(testOrgId, "standard");
    await prisma.organization.delete({ where: { id: testOrgId } });
  });
});
