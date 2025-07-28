import { replaceSuperJsonPayload } from "../src/v3/utils/ioSerialization.js";

describe("ioSerialization", () => {
  describe("replaceSuperJsonPayload", () => {
    it("should replace simple JSON payload while preserving SuperJSON metadata", async () => {
      const originalData = {
        name: "John",
        age: 30,
        date: new Date("2023-01-01"),
      };

      const superjson = await import("superjson");
      const originalSerialized = superjson.stringify(originalData);

      const newPayloadJson = JSON.stringify({
        name: "Jane",
        surname: "Doe",
        age: 25,
        date: "2023-02-01T00:00:00.000Z",
      });

      const result = (await replaceSuperJsonPayload(originalSerialized, newPayloadJson)) as any;

      expect(result.name).toBe("Jane");
      expect(result.surname).toBe("Doe");
      expect(result.age).toBe(25);
      expect(result.date).toBeInstanceOf(Date);
      expect(result.date.toISOString()).toBe("2023-02-01T00:00:00.000Z");
    });

    // related to issue https://github.com/triggerdotdev/trigger.dev/issues/1968
    it("should ignore original undefined type metadata for overriden fields", async () => {
      const originalData = {
        name: "John",
        age: 30,
        date: new Date("2023-01-01"),
        country: undefined,
        settings: {
          theme: undefined,
        },
      };

      const superjson = await import("superjson");
      const originalSerialized = superjson.stringify(originalData);

      const newPayloadJson = JSON.stringify({
        name: "Jane",
        surname: "Doe",
        age: 25,
        date: "2023-02-01T00:00:00.000Z",
        country: "US",
        settings: {
          theme: "dark",
        },
      });

      const result = (await replaceSuperJsonPayload(originalSerialized, newPayloadJson)) as any;

      expect(result.name).toBe("Jane");
      expect(result.surname).toBe("Doe");
      expect(result.country).toBe("US");
      expect(result.settings.theme).toBe("dark");
      expect(result.age).toBe(25);
      expect(result.date).toBeInstanceOf(Date);
      expect(result.date.toISOString()).toBe("2023-02-01T00:00:00.000Z");
    });

    it("should preserve BigInt type metadata", async () => {
      const originalData = {
        id: BigInt(123456789),
        count: 42,
      };

      const superjson = await import("superjson");
      const originalSerialized = superjson.stringify(originalData);

      const newPayloadJson = JSON.stringify({
        id: "987654321",
        count: 100,
      });

      const result = (await replaceSuperJsonPayload(originalSerialized, newPayloadJson)) as any;

      expect(result.id).toBe(BigInt(987654321));
      expect(typeof result.id).toBe("bigint");
      expect(result.count).toBe(100);
    });

    it("should preserve nested type metadata", async () => {
      const originalData = {
        user: {
          id: BigInt(123),
          createdAt: new Date("2023-01-01"),
          settings: {
            theme: "dark",
            updatedAt: new Date("2023-01-01"),
          },
        },
        metadata: {
          version: 1,
        },
      };

      const superjson = await import("superjson");
      const originalSerialized = superjson.stringify(originalData);

      const newPayloadJson = JSON.stringify({
        user: {
          id: "456",
          createdAt: "2023-06-01T00:00:00.000Z",
          settings: {
            theme: "light",
            updatedAt: "2023-06-01T00:00:00.000Z",
          },
        },
        metadata: {
          version: 2,
        },
      });

      const result = (await replaceSuperJsonPayload(originalSerialized, newPayloadJson)) as any;

      expect(result.user.id).toBe(BigInt(456));
      expect(result.user.createdAt).toBeInstanceOf(Date);
      expect(result.user.createdAt.toISOString()).toBe("2023-06-01T00:00:00.000Z");
      expect(result.user.settings.theme).toBe("light");
      expect(result.user.settings.updatedAt).toBeInstanceOf(Date);
      expect(result.user.settings.updatedAt.toISOString()).toBe("2023-06-01T00:00:00.000Z");
      expect(result.metadata.version).toBe(2);
    });

    it("should preserve Set type metadata", async () => {
      const originalData = {
        tags: new Set(["tag1", "tag2"]),
        name: "test",
      };

      const superjson = await import("superjson");
      const originalSerialized = superjson.stringify(originalData);

      const newPayloadJson = JSON.stringify({
        tags: ["tag3", "tag4", "tag5"],
        name: "updated",
      });

      const result = (await replaceSuperJsonPayload(originalSerialized, newPayloadJson)) as any;

      expect(result.tags).toBeInstanceOf(Set);
      expect(Array.from(result.tags)).toEqual(["tag3", "tag4", "tag5"]);
      expect(result.name).toBe("updated");
    });

    it("should preserve Map type metadata", async () => {
      const originalData = {
        mapping: new Map([
          ["key1", "value1"],
          ["key2", "value2"],
        ]),
        name: "test",
      };

      const superjson = await import("superjson");
      const originalSerialized = superjson.stringify(originalData);

      const newPayloadJson = JSON.stringify({
        mapping: [
          ["key3", "value3"],
          ["key4", "value4"],
        ],
        name: "updated",
      });

      const result = (await replaceSuperJsonPayload(originalSerialized, newPayloadJson)) as any;

      expect(result.mapping).toBeInstanceOf(Map);
      expect(result.mapping.get("key3")).toBe("value3");
      expect(result.mapping.get("key4")).toBe("value4");
      expect(result.name).toBe("updated");
    });

    it("should throw error for invalid JSON payload", async () => {
      const originalData = { name: "test" };

      const superjson = await import("superjson");
      const originalSerialized = superjson.stringify(originalData);
      const invalidPayload = "{ invalid json }";

      await expect(replaceSuperJsonPayload(originalSerialized, invalidPayload)).rejects.toThrow();
    });
  });
});
