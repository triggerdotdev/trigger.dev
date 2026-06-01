import { createTestHttpServer } from "@epic-web/test-server/http";
import {
  replaceSuperJsonPayload,
  prettyPrintPacket,
  conditionallyExportPacket,
  type IOPacket,
} from "../src/v3/utils/ioSerialization.js";
import { ApiClient } from "../src/v3/apiClient/index.js";
import { apiClientManager } from "../src/v3/apiClientManager-api.js";

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

  describe("prettyPrintPacket", () => {
    it("should return empty string for undefined data", async () => {
      const result = await prettyPrintPacket(undefined);
      expect(result).toBe("");
    });

    it("should return string data as-is", async () => {
      const result = await prettyPrintPacket("Hello, World!");
      expect(result).toBe("Hello, World!");
    });

    it("should pretty print JSON data with default options", async () => {
      const data = { name: "John", age: 30, nested: { value: true } };
      const result = await prettyPrintPacket(data, "application/json");

      expect(result).toBe(JSON.stringify(data, null, 2));
    });

    it("should handle JSON data as string", async () => {
      const data = { name: "John", age: 30 };
      const jsonString = JSON.stringify(data);
      const result = await prettyPrintPacket(jsonString, "application/json");

      expect(result).toBe(JSON.stringify(data, null, 2));
    });

    it("should pretty print SuperJSON data", async () => {
      const data = {
        name: "John",
        date: new Date("2023-01-01"),
        bigInt: BigInt(123),
        set: new Set(["a", "b"]),
        map: new Map([["key", "value"]]),
      };

      const superjson = await import("superjson");
      const serialized = superjson.stringify(data);

      const result = await prettyPrintPacket(serialized, "application/super+json");

      // Should deserialize and pretty print the data
      expect(result).toContain('"name": "John"');
      expect(result).toContain('"date": "2023-01-01T00:00:00.000Z"');
      expect(result).toContain('"bigInt": "123"');
      expect(result).toContain('"set": [\n    "a",\n    "b"\n  ]');
      expect(result).toContain('"map": {\n    "key": "value"\n  }');
    });

    it("should handle circular references", async () => {
      const data: any = { name: "John" };
      data.self = data; // Create circular reference

      // Create a SuperJSON serialized version to test the circular reference detection
      const superjson = await import("superjson");
      const serialized = superjson.stringify(data);

      const result = await prettyPrintPacket(serialized, "application/super+json");

      expect(result).toContain('"name": "John"');
      expect(result).toContain('"self": "[Circular]"');
    });

    it("should handle regular non-circular references", async () => {
      const person = { name: "John" };

      const data: any = { person1: person, person2: person };

      // Create a SuperJSON serialized version to test the circular reference detection
      const superjson = await import("superjson");
      const serialized = superjson.stringify(data);

      const result = await prettyPrintPacket(serialized, "application/super+json");

      expect(result).toContain('"person1": {');
      expect(result).toContain('"person2": {');
    });

    it("should filter out specified keys", async () => {
      const data = { name: "John", password: "secret", age: 30 };
      const result = await prettyPrintPacket(data, "application/json", {
        filteredKeys: ["password"],
      });

      expect(result).toContain('"name": "John"');
      expect(result).toContain('"age": 30');
      expect(result).not.toContain('"password"');
    });

    it("should handle BigInt values", async () => {
      const data = { id: BigInt(123456789), name: "John" };
      const result = await prettyPrintPacket(data, "application/json");

      expect(result).toContain('"id": "123456789"');
      expect(result).toContain('"name": "John"');
    });

    it("should handle RegExp values", async () => {
      const data = { pattern: /test/gi, name: "John" };
      const result = await prettyPrintPacket(data, "application/json");

      expect(result).toContain('"pattern": "/test/gi"');
      expect(result).toContain('"name": "John"');
    });

    it("should handle Set values", async () => {
      const data = { tags: new Set(["tag1", "tag2"]), name: "John" };
      const result = await prettyPrintPacket(data, "application/json");

      expect(result).toContain('"tags": [\n    "tag1",\n    "tag2"\n  ]');
      expect(result).toContain('"name": "John"');
    });

    it("should handle Map values", async () => {
      const data = { mapping: new Map([["key1", "value1"]]), name: "John" };
      const result = await prettyPrintPacket(data, "application/json");

      expect(result).toContain('"mapping": {\n    "key1": "value1"\n  }');
      expect(result).toContain('"name": "John"');
    });

    it("should handle complex nested data", async () => {
      const data = {
        user: {
          id: BigInt(123),
          createdAt: new Date("2023-01-01"),
          settings: {
            theme: "dark",
            tags: new Set(["admin", "user"]),
            config: new Map([["timeout", "30s"]]),
          },
        },
        metadata: {
          version: 1,
          pattern: /^test$/,
        },
      };

      const result = await prettyPrintPacket(data, "application/json");

      expect(result).toContain('"id": "123"');
      expect(result).toContain('"createdAt": "2023-01-01T00:00:00.000Z"');
      expect(result).toContain('"theme": "dark"');
      expect(result).toContain('"tags": [\n        "admin",\n        "user"\n      ]');
      expect(result).toContain('"config": {\n        "timeout": "30s"\n      }');
      expect(result).toContain('"version": 1');
      expect(result).toContain('"pattern": "/^test$/"');
    });

    it("should handle data without dataType parameter", async () => {
      const data = { name: "John", age: 30 };
      const result = await prettyPrintPacket(data);

      expect(result).toBe(JSON.stringify(data, null, 2));
    });
  });

  describe("conditionallyExportPacket", () => {
    // A payload large enough to exceed OFFLOAD_IO_PACKET_LENGTH_LIMIT (128KB) so it offloads.
    const largePayload = "x".repeat(200_000);
    const largePacket: IOPacket = { data: largePayload, dataType: "text/plain" };

    afterEach(() => {
      // Clear any global client config set during a test.
      apiClientManager.disable();
    });

    it("uses the provided client for the upload presign instead of the global client", async () => {
      const globalPresignRequests: string[] = [];
      const passedPresignRequests: string[] = [];
      let uploadedBytes = 0;

      // The global client points here — it must NOT be hit when a client is passed.
      const globalServer = await createTestHttpServer({
        defineRoutes(router) {
          router.put("/api/v2/packets/:filename", async ({ req }) => {
            globalPresignRequests.push(req.url);
            return Response.json({ presignedUrl: "http://unused.local/upload" });
          });
        },
      });

      // The explicitly passed client points here — it MUST receive the presign + upload.
      const passedServer = await createTestHttpServer({
        defineRoutes(router) {
          router.put("/api/v2/packets/:filename", async ({ req }) => {
            passedPresignRequests.push(req.url);
            return Response.json({
              presignedUrl: `${passedServer.http.url().origin}/upload/payload`,
              storagePath: "trigger/task/payload.txt",
            });
          });
          router.put("/upload/payload", async ({ req }) => {
            uploadedBytes = (await req.text()).length;
            return new Response(null, { status: 200 });
          });
        },
      });

      try {
        // Configure the global client to point at the global server.
        apiClientManager.setGlobalAPIClientConfiguration({
          baseURL: globalServer.http.url().origin,
          accessToken: "tr-global",
        });

        const passedClient = new ApiClient(passedServer.http.url().origin, "tr-passed");

        const result = await conditionallyExportPacket(
          largePacket,
          "trigger/task/payload",
          undefined,
          passedClient
        );

        expect(result.dataType).toBe("application/store");
        expect(result.data).toBe("trigger/task/payload.txt");

        // Upload went through the passed client only.
        expect(passedPresignRequests).toHaveLength(1);
        expect(globalPresignRequests).toHaveLength(0);
        expect(uploadedBytes).toBe(largePayload.length);
      } finally {
        await globalServer.close();
        await passedServer.close();
      }
    });

    it("falls back to the global client when no client is provided", async () => {
      const presignRequests: string[] = [];

      const globalServer = await createTestHttpServer({
        defineRoutes(router) {
          router.put("/api/v2/packets/:filename", async ({ req }) => {
            presignRequests.push(req.url);
            return Response.json({
              presignedUrl: `${globalServer.http.url().origin}/upload/payload`,
              storagePath: "trigger/task/payload.txt",
            });
          });
          router.put("/upload/payload", async () => new Response(null, { status: 200 }));
        },
      });

      try {
        apiClientManager.setGlobalAPIClientConfiguration({
          baseURL: globalServer.http.url().origin,
          accessToken: "tr-global",
        });

        const result = await conditionallyExportPacket(largePacket, "trigger/task/payload");

        expect(result.dataType).toBe("application/store");
        expect(result.data).toBe("trigger/task/payload.txt");
        expect(presignRequests).toHaveLength(1);
      } finally {
        await globalServer.close();
      }
    });

    it("returns the packet unchanged when no client is available", async () => {
      apiClientManager.disable();

      const result = await conditionallyExportPacket(largePacket, "trigger/task/payload");

      expect(result).toEqual(largePacket);
    });

    it("does not offload small payloads even with a client", async () => {
      const passedServer = await createTestHttpServer({
        defineRoutes(router) {
          router.put("/api/v2/packets/:filename", async () => {
            throw new Error("presign should not be called for small payloads");
          });
        },
      });

      try {
        const smallPacket: IOPacket = { data: "hello", dataType: "text/plain" };
        const passedClient = new ApiClient(passedServer.http.url().origin, "tr-passed");

        const result = await conditionallyExportPacket(
          smallPacket,
          "trigger/task/payload",
          undefined,
          passedClient
        );

        expect(result).toEqual(smallPacket);
      } finally {
        await passedServer.close();
      }
    });
  });
});
