import { describe, expect, vi } from "vitest";

// Mock the db prisma client (required for webapp service imports)
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { postgresTest } from "@internal/testcontainers";
import { SchemaRegistryService } from "../../app/v3/services/events/schemaRegistry.server";

vi.setConfig({ testTimeout: 120_000 });

describe("SchemaRegistryService DB methods", () => {
  postgresTest(
    "registerSchema creates a new EventDefinition",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const service = new SchemaRegistryService(prisma);

      const result = await service.registerSchema({
        projectId: env.projectId,
        eventSlug: "order.created",
        version: "1.0",
        schema: {
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
        },
        description: "Order created event",
      });

      expect(result.eventDefinitionId).toBeDefined();

      // Verify in DB
      const dbRecord = await prisma.eventDefinition.findUnique({
        where: { id: result.eventDefinitionId },
      });

      expect(dbRecord).toBeDefined();
      expect(dbRecord!.slug).toBe("order.created");
      expect(dbRecord!.version).toBe("1.0");
      expect(dbRecord!.description).toBe("Order created event");
      expect(dbRecord!.schema).toBeDefined();
    }
  );

  postgresTest(
    "registerSchema upserts on same slug+version+project",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const service = new SchemaRegistryService(prisma);

      // First registration
      const result1 = await service.registerSchema({
        projectId: env.projectId,
        eventSlug: "user.updated",
        version: "1.0",
        schema: { type: "object", properties: { name: { type: "string" } } },
        description: "v1 description",
      });

      // Update same slug+version+project
      const result2 = await service.registerSchema({
        projectId: env.projectId,
        eventSlug: "user.updated",
        version: "1.0",
        schema: {
          type: "object",
          properties: { name: { type: "string" }, age: { type: "number" } },
        },
        description: "v1 updated description",
      });

      // Same record was updated (not duplicated)
      expect(result2.eventDefinitionId).toBe(result1.eventDefinitionId);

      const dbRecord = await prisma.eventDefinition.findUnique({
        where: { id: result2.eventDefinitionId },
      });
      expect(dbRecord!.description).toBe("v1 updated description");
    }
  );

  postgresTest(
    "getSchema returns latest version by default",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const service = new SchemaRegistryService(prisma);

      await service.registerSchema({
        projectId: env.projectId,
        eventSlug: "order.shipped",
        version: "1.0",
        schema: { type: "object" },
      });

      // Create v2 slightly later
      await new Promise((r) => setTimeout(r, 10));
      await service.registerSchema({
        projectId: env.projectId,
        eventSlug: "order.shipped",
        version: "2.0",
        schema: { type: "object", properties: { trackingId: { type: "string" } } },
      });

      const result = await service.getSchema({
        projectId: env.projectId,
        eventSlug: "order.shipped",
      });

      expect(result).toBeDefined();
      expect(result!.version).toBe("2.0");
    }
  );

  postgresTest(
    "getSchema returns specific version when requested",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const service = new SchemaRegistryService(prisma);

      await service.registerSchema({
        projectId: env.projectId,
        eventSlug: "test.versioned",
        version: "1.0",
        schema: { type: "object" },
        description: "Version 1",
      });

      await service.registerSchema({
        projectId: env.projectId,
        eventSlug: "test.versioned",
        version: "2.0",
        schema: { type: "object" },
        description: "Version 2",
      });

      const v1 = await service.getSchema({
        projectId: env.projectId,
        eventSlug: "test.versioned",
        version: "1.0",
      });

      expect(v1).toBeDefined();
      expect(v1!.version).toBe("1.0");
      expect(v1!.description).toBe("Version 1");
    }
  );

  postgresTest(
    "getSchema returns null for nonexistent event",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const service = new SchemaRegistryService(prisma);

      const result = await service.getSchema({
        projectId: env.projectId,
        eventSlug: "nonexistent.event",
      });

      expect(result).toBeNull();
    }
  );

  postgresTest(
    "listSchemas returns all events with subscriber counts",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const service = new SchemaRegistryService(prisma);

      // Register two events
      await service.registerSchema({
        projectId: env.projectId,
        eventSlug: "event.a",
        version: "1.0",
        schema: { type: "object" },
      });

      await service.registerSchema({
        projectId: env.projectId,
        eventSlug: "event.b",
        version: "1.0",
        schema: { type: "object" },
      });

      const result = await service.listSchemas({
        projectId: env.projectId,
      });

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.slug).sort()).toEqual(["event.a", "event.b"]);
      // No subscriptions yet, so subscriber counts should be 0
      expect(result.every((r) => r.subscriberCount === 0)).toBe(true);
    }
  );
});
