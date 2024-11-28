import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createTestHttpServer } from "@epic-web/test-server/http";
import { StandardMetadataManager } from "../src/v3/runMetadata/manager.js";
import { ApiClient } from "../src/v3/apiClient/index.js";

describe("StandardMetadataManager", () => {
  const runId = "test-run-id";
  let server: Awaited<ReturnType<typeof createTestHttpServer>>;
  let metadataUpdates: Array<Record<string, any>> = [];
  let manager: StandardMetadataManager;

  beforeEach(async () => {
    metadataUpdates = [];

    server = await createTestHttpServer({
      defineRoutes(router) {
        router.put("/api/v1/runs/:runId/metadata", async ({ req }) => {
          const body = await req.json();
          metadataUpdates.push(body);
          return Response.json({ metadata: body.metadata });
        });
      },
    });

    const apiClient = new ApiClient(server.http.url().origin, "tr-123");

    manager = new StandardMetadataManager(apiClient, server.http.url().origin);
    manager.runId = runId;
  });

  afterEach(async () => {
    await server.close();
  });

  test("should initialize with empty store", () => {
    expect(manager.current()).toBeUndefined();
  });

  test("should set and get simple keys", () => {
    manager.setKey("test", "value");
    expect(manager.getKey("test")).toBe("value");
  });

  test("should handle JSON path keys", () => {
    manager.setKey("nested", { foo: "bar" });
    manager.setKey("$.nested.path", "value");
    expect(manager.current()).toEqual({
      nested: {
        foo: "bar",
        path: "value",
      },
    });
  });

  test("should flush changes to server", async () => {
    manager.setKey("test", "value");
    await manager.flush();

    expect(metadataUpdates).toHaveLength(1);
    expect(metadataUpdates[0]).toEqual({
      metadata: {
        test: "value",
      },
    });
  });

  test("should only flush to server when data has actually changed", async () => {
    // Initial set and flush
    manager.setKey("test", "value");
    await manager.flush();
    expect(metadataUpdates).toHaveLength(1);

    // Same value set again
    manager.setKey("test", "value");
    await manager.flush();
    // Should not trigger another update since value hasn't changed
    expect(metadataUpdates).toHaveLength(1);

    // Different value set
    manager.setKey("test", "new value");
    await manager.flush();
    // Should trigger new update
    expect(metadataUpdates).toHaveLength(2);
  });

  test("should only flush to server when nested data has actually changed", async () => {
    // Initial nested object
    manager.setKey("nested", { foo: "bar" });
    await manager.flush();
    expect(metadataUpdates).toHaveLength(1);

    // Same nested value
    manager.setKey("nested", { foo: "bar" });
    await manager.flush();
    // Should not trigger another update
    expect(metadataUpdates).toHaveLength(1);

    // Different nested value
    manager.setKey("nested", { foo: "baz" });
    await manager.flush();
    // Should trigger new update
    expect(metadataUpdates).toHaveLength(2);
  });

  test("should append to list with simple key", () => {
    // First append creates the array
    manager.appendKey("myList", "first");
    expect(manager.getKey("myList")).toEqual(["first"]);

    // Second append adds to existing array
    manager.appendKey("myList", "second");
    expect(manager.getKey("myList")).toEqual(["first", "second"]);
  });

  test("should append to list with JSON path", () => {
    // First create nested structure
    manager.setKey("nested", { items: [] });

    // Append to empty array
    manager.appendKey("$.nested.items", "first");
    expect(manager.current()).toEqual({
      nested: {
        items: ["first"],
      },
    });

    // Append another item
    manager.appendKey("$.nested.items", "second");
    expect(manager.current()).toEqual({
      nested: {
        items: ["first", "second"],
      },
    });
  });

  test("should convert non-array values to array when appending", () => {
    // Set initial non-array value
    manager.setKey("value", "initial");

    // Append should convert to array
    manager.appendKey("value", "second");
    expect(manager.getKey("value")).toEqual(["initial", "second"]);
  });

  test("should convert non-array values to array when appending with JSON path", () => {
    // Set initial nested non-array value
    manager.setKey("nested", { value: "initial" });

    // Append should convert to array
    manager.appendKey("$.nested.value", "second");
    expect(manager.current()).toEqual({
      nested: {
        value: ["initial", "second"],
      },
    });
  });

  test("should trigger server update when appending to list", async () => {
    manager.appendKey("myList", "first");
    await manager.flush();

    expect(metadataUpdates).toHaveLength(1);
    expect(metadataUpdates[0]).toEqual({
      metadata: {
        myList: ["first"],
      },
    });

    manager.appendKey("myList", "second");
    await manager.flush();

    expect(metadataUpdates).toHaveLength(2);
    expect(metadataUpdates[1]).toEqual({
      metadata: {
        myList: ["first", "second"],
      },
    });
  });

  test("should not trigger server update when appending same value", async () => {
    manager.appendKey("myList", "first");
    await manager.flush();

    expect(metadataUpdates).toHaveLength(1);

    // Append same value
    manager.appendKey("myList", "first");
    await manager.flush();

    // Should still be only one update
    expect(metadataUpdates).toHaveLength(2);
  });

  test("should increment and decrement keys", () => {
    manager.incrementKey("counter");
    expect(manager.getKey("counter")).toBe(1);

    manager.incrementKey("counter", 5);
    expect(manager.getKey("counter")).toBe(6);

    manager.decrementKey("counter");
    expect(manager.getKey("counter")).toBe(5);

    manager.decrementKey("counter", 3);
    expect(manager.getKey("counter")).toBe(2);
  });

  test("should remove value from array with simple key", () => {
    // Setup initial array
    manager.setKey("myList", ["first", "second", "third"]);

    // Remove a value
    manager.removeFromKey("myList", "second");
    expect(manager.getKey("myList")).toEqual(["first", "third"]);
  });

  test("should remove value from array with JSON path", () => {
    // Setup initial nested array
    manager.setKey("nested", { items: ["first", "second", "third"] });

    // Remove a value
    manager.removeFromKey("$.nested.items", "second");
    expect(manager.current()).toEqual({
      nested: {
        items: ["first", "third"],
      },
    });
  });

  test("should handle removing non-existent value", () => {
    // Setup initial array
    manager.setKey("myList", ["first", "second"]);

    // Try to remove non-existent value
    manager.removeFromKey("myList", "third");
    expect(manager.getKey("myList")).toEqual(["first", "second"]);
  });

  test("should handle removing from non-array values", () => {
    // Setup non-array value
    manager.setKey("value", "string");

    // Try to remove from non-array
    manager.removeFromKey("value", "something");
    expect(manager.getKey("value")).toBe("string");
  });

  test("should remove object from array using deep equality", () => {
    // Setup array with objects
    manager.setKey("objects", [
      { id: 1, name: "first" },
      { id: 2, name: "second" },
      { id: 3, name: "third" },
    ]);

    // Remove object
    manager.removeFromKey("objects", { id: 2, name: "second" });
    expect(manager.getKey("objects")).toEqual([
      { id: 1, name: "first" },
      { id: 3, name: "third" },
    ]);
  });

  test("should trigger server update when removing from array", async () => {
    // Setup initial array
    manager.setKey("myList", ["first", "second", "third"]);
    await manager.flush();
    expect(metadataUpdates).toHaveLength(1);

    // Remove value
    manager.removeFromKey("myList", "second");
    await manager.flush();

    expect(metadataUpdates).toHaveLength(2);
    expect(metadataUpdates[1]).toEqual({
      metadata: {
        myList: ["first", "third"],
      },
    });
  });

  test("should not trigger server update when removing non-existent value", async () => {
    // Setup initial array
    manager.setKey("myList", ["first", "second"]);
    await manager.flush();
    expect(metadataUpdates).toHaveLength(1);

    // Try to remove non-existent value
    manager.removeFromKey("myList", "third");
    await manager.flush();

    // Should not trigger new update since nothing changed
    expect(metadataUpdates).toHaveLength(1);
  });
});
