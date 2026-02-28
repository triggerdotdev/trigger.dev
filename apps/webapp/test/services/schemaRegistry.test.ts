import { describe, it, expect, beforeEach } from "vitest";
import { SchemaRegistryService } from "../../app/v3/services/events/schemaRegistry.server";

// Unit tests for schema validation and compatibility checks
// (no DB needed — these test the pure logic functions)

describe("SchemaRegistryService", () => {
  let service: SchemaRegistryService;

  beforeEach(() => {
    service = new SchemaRegistryService({} as any); // prisma not needed for validatePayload/checkCompatibility
    SchemaRegistryService.clearCache();
  });

  describe("validatePayload", () => {
    it("returns success when no schema is defined", () => {
      const result = service.validatePayload("evt-1", null, { any: "data" });
      expect(result).toEqual({ success: true });
    });

    it("validates payload against a JSON schema — valid payload", () => {
      const schema = {
        type: "object",
        properties: {
          orderId: { type: "string" },
          amount: { type: "number" },
        },
        required: ["orderId", "amount"],
      };

      const result = service.validatePayload("evt-2", schema, {
        orderId: "ord-123",
        amount: 99.99,
      });

      expect(result).toEqual({ success: true });
    });

    it("rejects invalid payload with descriptive errors", () => {
      const schema = {
        type: "object",
        properties: {
          orderId: { type: "string" },
          amount: { type: "number" },
        },
        required: ["orderId", "amount"],
      };

      const result = service.validatePayload("evt-3", schema, {
        orderId: 123, // wrong type
        // missing amount
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
        // Should have errors about orderId type and missing amount
        const messages = result.errors.map((e) => e.message);
        expect(messages.some((m) => m.includes("string") || m.includes("type"))).toBe(true);
      }
    });

    it("validates arrays and nested objects", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
              required: ["name"],
            },
          },
        },
        required: ["items"],
      };

      const validResult = service.validatePayload("evt-4", schema, {
        items: [{ name: "item1" }, { name: "item2" }],
      });
      expect(validResult.success).toBe(true);

      const invalidResult = service.validatePayload("evt-4b", schema, {
        items: [{ name: 123 }], // wrong type
      });
      expect(invalidResult.success).toBe(false);
    });

    it("caches compiled validators", () => {
      const schema = {
        type: "object",
        properties: { x: { type: "number" } },
      };

      // First call compiles
      const result1 = service.validatePayload("evt-cache", schema, { x: 1 });
      expect(result1.success).toBe(true);

      // Second call uses cache
      const result2 = service.validatePayload("evt-cache", schema, { x: 2 });
      expect(result2.success).toBe(true);
    });

    it("returns success for malformed schema (does not block publish)", () => {
      const badSchema = "not a valid schema";
      const result = service.validatePayload("evt-bad", badSchema, { any: "data" });
      expect(result.success).toBe(true);
    });
  });

  describe("checkCompatibility", () => {
    it("returns compatible when both schemas are null", () => {
      const result = service.checkCompatibility(null, null);
      expect(result).toEqual({ compatible: true });
    });

    it("returns compatible when old schema is null", () => {
      const result = service.checkCompatibility(null, {
        type: "object",
        properties: { x: { type: "string" } },
      });
      expect(result).toEqual({ compatible: true });
    });

    it("compatible: adding optional field", () => {
      const oldSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      };

      const newSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" }, // new optional field
        },
        required: ["name"],
      };

      const result = service.checkCompatibility(oldSchema, newSchema);
      expect(result).toEqual({ compatible: true });
    });

    it("incompatible: adding new required field not in old schema", () => {
      const oldSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      };

      const newSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
        },
        required: ["name", "email"], // email is now required
      };

      const result = service.checkCompatibility(oldSchema, newSchema);
      expect(result.compatible).toBe(false);
      if (!result.compatible) {
        expect(result.reasons).toHaveLength(1);
        expect(result.reasons[0]).toContain("email");
      }
    });

    it("incompatible: removing required field", () => {
      const oldSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
        },
        required: ["name", "email"],
      };

      const newSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          // email removed
        },
        required: ["name"],
      };

      const result = service.checkCompatibility(oldSchema, newSchema);
      expect(result.compatible).toBe(false);
      if (!result.compatible) {
        expect(result.reasons[0]).toContain("email");
        expect(result.reasons[0]).toContain("removed");
      }
    });

    it("incompatible: changing field type", () => {
      const oldSchema = {
        type: "object",
        properties: {
          count: { type: "number" },
        },
        required: ["count"],
      };

      const newSchema = {
        type: "object",
        properties: {
          count: { type: "string" }, // changed from number to string
        },
        required: ["count"],
      };

      const result = service.checkCompatibility(oldSchema, newSchema);
      expect(result.compatible).toBe(false);
      if (!result.compatible) {
        expect(result.reasons[0]).toContain("count");
        expect(result.reasons[0]).toContain("type");
      }
    });
  });
});
