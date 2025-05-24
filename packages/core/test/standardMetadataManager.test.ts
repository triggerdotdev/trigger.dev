import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createTestHttpServer } from "@epic-web/test-server/http";
import { StandardMetadataManager } from "../src/v3/runMetadata/manager.js";
import { ApiClient } from "../src/v3/apiClient/index.js";
import { UpdateMetadataRequestBody } from "../src/v3/schemas/index.js";
import { applyMetadataOperations, collapseOperations } from "../src/v3/runMetadata/operations.js";

describe("StandardMetadataManager", () => {
  const runId = "test-run-id";
  let server: Awaited<ReturnType<typeof createTestHttpServer>>;
  let metadataUpdates: Array<UpdateMetadataRequestBody> = [];
  let manager: StandardMetadataManager;

  beforeEach(async () => {
    metadataUpdates = [];
    const store = {};

    server = await createTestHttpServer({
      defineRoutes(router) {
        router.put("/api/v1/runs/:runId/metadata", async ({ req }) => {
          const body = await req.json();
          const parsedBody = UpdateMetadataRequestBody.parse(body);

          metadataUpdates.push(parsedBody);

          const { newMetadata } = applyMetadataOperations(store, parsedBody.operations ?? []);

          return Response.json({ metadata: newMetadata });
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
    manager.set("test", "value");
    expect(manager.getKey("test")).toBe("value");
  });

  test("should handle JSON path keys", () => {
    manager.set("nested", { foo: "bar" });
    manager.set("$.nested.path", "value");
    expect(manager.current()).toEqual({
      nested: {
        foo: "bar",
        path: "value",
      },
    });
  });

  test("should flush changes to server", async () => {
    manager.set("test", "value");
    await manager.flush();

    expect(metadataUpdates).toHaveLength(1);
  });

  test("should only flush to server when data has actually changed", async () => {
    // Initial set and flush
    manager.set("test", "value");
    await manager.flush();
    expect(metadataUpdates).toHaveLength(1);

    // Same value set again
    manager.set("test", "value");
    await manager.flush();
    // Should not trigger another update since value hasn't changed
    expect(metadataUpdates).toHaveLength(1);

    // Different value set
    manager.set("test", "new value");
    await manager.flush();
    // Should trigger new update
    expect(metadataUpdates).toHaveLength(2);
  });

  test("should only flush to server when nested data has actually changed", async () => {
    // Initial nested object
    manager.set("nested", { foo: "bar" });
    await manager.flush();
    expect(metadataUpdates).toHaveLength(1);

    // Same nested value
    manager.set("nested", { foo: "bar" });
    await manager.flush();
    // Should not trigger another update
    expect(metadataUpdates).toHaveLength(1);

    // Different nested value
    manager.set("nested", { foo: "baz" });
    await manager.flush();
    // Should trigger new update
    expect(metadataUpdates).toHaveLength(2);
  });

  test("should append to list with simple key", () => {
    // First append creates the array
    manager.append("myList", "first");
    expect(manager.getKey("myList")).toEqual(["first"]);

    // Second append adds to existing array
    manager.append("myList", "second");
    expect(manager.getKey("myList")).toEqual(["first", "second"]);
  });

  test("should append to list with JSON path", () => {
    // First create nested structure
    manager.set("nested", { items: [] });

    // Append to empty array
    manager.append("$.nested.items", "first");
    expect(manager.current()).toEqual({
      nested: {
        items: ["first"],
      },
    });

    // Append another item
    manager.append("$.nested.items", "second");
    expect(manager.current()).toEqual({
      nested: {
        items: ["first", "second"],
      },
    });
  });

  test("should convert non-array values to array when appending", () => {
    // Set initial non-array value
    manager.set("value", "initial");

    // Append should convert to array
    manager.append("value", "second");
    expect(manager.getKey("value")).toEqual(["initial", "second"]);
  });

  test("should convert non-array values to array when appending with JSON path", () => {
    // Set initial nested non-array value
    manager.set("nested", { value: "initial" });

    // Append should convert to array
    manager.append("$.nested.value", "second");
    expect(manager.current()).toEqual({
      nested: {
        value: ["initial", "second"],
      },
    });
  });

  test("should trigger server update when appending to list", async () => {
    manager.append("myList", "first");
    await manager.flush();

    expect(metadataUpdates).toHaveLength(1);

    manager.append("myList", "second");
    await manager.flush();

    expect(metadataUpdates).toHaveLength(2);
  });

  test("should not trigger server update when appending same value", async () => {
    manager.append("myList", "first");
    await manager.flush();

    expect(metadataUpdates).toHaveLength(1);

    // Append same value
    manager.append("myList", "first");
    await manager.flush();

    // Should still be only one update
    expect(metadataUpdates).toHaveLength(2);
  });

  test("should increment and decrement keys", () => {
    manager.increment("counter");
    expect(manager.getKey("counter")).toBe(1);

    manager.increment("counter", 5);
    expect(manager.getKey("counter")).toBe(6);

    manager.decrement("counter");
    expect(manager.getKey("counter")).toBe(5);

    manager.decrement("counter", 3);
    expect(manager.getKey("counter")).toBe(2);
  });

  test("should remove value from array with simple key", () => {
    // Setup initial array
    manager.set("myList", ["first", "second", "third"]);

    // Remove a value
    manager.remove("myList", "second");
    expect(manager.getKey("myList")).toEqual(["first", "third"]);
  });

  test("should remove value from array with JSON path", () => {
    // Setup initial nested array
    manager.set("nested", { items: ["first", "second", "third"] });

    // Remove a value
    manager.remove("$.nested.items", "second");
    expect(manager.current()).toEqual({
      nested: {
        items: ["first", "third"],
      },
    });
  });

  test("should handle removing non-existent value", () => {
    // Setup initial array
    manager.set("myList", ["first", "second"]);

    // Try to remove non-existent value
    manager.remove("myList", "third");
    expect(manager.getKey("myList")).toEqual(["first", "second"]);
  });

  test("should handle removing from non-array values", () => {
    // Setup non-array value
    manager.set("value", "string");

    // Try to remove from non-array
    manager.remove("value", "something");
    expect(manager.getKey("value")).toBe("string");
  });

  test("should remove object from array using deep equality", () => {
    // Setup array with objects
    manager.set("objects", [
      { id: 1, name: "first" },
      { id: 2, name: "second" },
      { id: 3, name: "third" },
    ]);

    // Remove object
    manager.remove("objects", { id: 2, name: "second" });
    expect(manager.getKey("objects")).toEqual([
      { id: 1, name: "first" },
      { id: 3, name: "third" },
    ]);
  });

  test("should trigger server update when removing from array", async () => {
    // Setup initial array
    manager.set("myList", ["first", "second", "third"]);
    await manager.flush();
    expect(metadataUpdates).toHaveLength(1);

    // Remove value
    manager.remove("myList", "second");
    await manager.flush();

    expect(metadataUpdates).toHaveLength(2);
  });

  test("should not trigger server update when removing non-existent value", async () => {
    // Setup initial array
    manager.set("myList", ["first", "second"]);
    await manager.flush();
    expect(metadataUpdates).toHaveLength(1);

    // Try to remove non-existent value
    manager.remove("myList", "third");
    await manager.flush();

    // Should not trigger new update since nothing changed
    expect(metadataUpdates).toHaveLength(1);
  });

  describe("operation collapsing", () => {
    test("should collapse multiple increment operations on the same key", async () => {
      // Perform multiple increments on the same key
      manager.increment("filesProcessed", 1);
      manager.increment("filesProcessed", 2);
      manager.increment("filesProcessed", 3);
      manager.increment("filesProcessed", 4);

      await manager.flush();

      expect(metadataUpdates).toHaveLength(1);

      // Should have only one increment operation with sum value
      const update = metadataUpdates[0]!;
      expect(update.operations).toHaveLength(1);
      expect(update.operations![0]).toEqual({
        type: "increment",
        key: "filesProcessed",
        value: 10, // 1 + 2 + 3 + 4
      });
    });

    test("should collapse multiple set operations on the same key, keeping only the last", async () => {
      // Perform multiple sets on the same key
      manager.set("status", "started");
      manager.set("status", "processing");
      manager.set("status", "completed");

      await manager.flush();

      expect(metadataUpdates).toHaveLength(1);

      // Should have only one set operation with the last value
      const update = metadataUpdates[0]!;
      expect(update.operations).toHaveLength(1);
      expect(update.operations![0]).toEqual({
        type: "set",
        key: "status",
        value: "completed",
      });
    });

    test("should collapse multiple delete operations on the same key", async () => {
      // Set initial value and flush
      manager.set("tempData", "some value");
      await manager.flush();
      expect(metadataUpdates).toHaveLength(1);

      // Perform multiple deletes on the same key
      manager.del("tempData");
      manager.del("tempData");
      manager.del("tempData");

      await manager.flush();

      expect(metadataUpdates).toHaveLength(2);

      // Should have only one delete operation
      const update = metadataUpdates[1]!;
      expect(update.operations).toHaveLength(1);
      expect(update.operations![0]).toEqual({
        type: "delete",
        key: "tempData",
      });
    });

    test("should preserve append operations without collapsing", async () => {
      // Perform multiple appends (order matters, so they shouldn't be collapsed)
      manager.append("events", "event1");
      manager.append("events", "event2");
      manager.append("events", "event3");

      await manager.flush();

      expect(metadataUpdates).toHaveLength(1);

      // Should preserve all append operations
      const update = metadataUpdates[0]!;
      expect(update.operations).toHaveLength(3);
      expect(update.operations![0]).toEqual({
        type: "append",
        key: "events",
        value: "event1",
      });
      expect(update.operations![1]).toEqual({
        type: "append",
        key: "events",
        value: "event2",
      });
      expect(update.operations![2]).toEqual({
        type: "append",
        key: "events",
        value: "event3",
      });
    });

    test("should handle mixed operations correctly", async () => {
      // Mix of different operation types
      manager.increment("counter", 5);
      manager.set("status", "processing");
      manager.append("logs", "Started processing");
      manager.increment("counter", 3);
      manager.set("status", "completed");
      manager.append("logs", "Processing completed");
      manager.del("tempData");
      manager.del("tempData"); // Duplicate delete (these won't be queued since key doesn't exist)

      await manager.flush();

      expect(metadataUpdates).toHaveLength(1);

      const update = metadataUpdates[0]!;
      const operations = update.operations!;

      // Should have: 1 collapsed increment, 1 collapsed set, 2 appends
      // (delete operations on non-existent keys are not queued)
      expect(operations).toHaveLength(4);

      // Find each operation type
      const incrementOp = operations.find((op) => op.type === "increment");
      const setOp = operations.find((op) => op.type === "set");
      const appendOps = operations.filter((op) => op.type === "append");

      expect(incrementOp).toEqual({
        type: "increment",
        key: "counter",
        value: 8, // 5 + 3
      });

      expect(setOp).toEqual({
        type: "set",
        key: "status",
        value: "completed", // Last set value
      });

      expect(appendOps).toHaveLength(2);
      expect(appendOps[0]).toEqual({
        type: "append",
        key: "logs",
        value: "Started processing",
      });
      expect(appendOps[1]).toEqual({
        type: "append",
        key: "logs",
        value: "Processing completed",
      });
    });

    test("should handle mixed operations with delete of existing keys correctly", async () => {
      // Set up initial data
      manager.set("tempData1", "value1");
      manager.set("tempData2", "value2");
      await manager.flush();
      expect(metadataUpdates).toHaveLength(1);

      // Mix of different operation types including deletes of existing keys
      manager.increment("counter", 5);
      manager.set("status", "processing");
      manager.append("logs", "Started processing");
      manager.increment("counter", 3);
      manager.set("status", "completed");
      manager.append("logs", "Processing completed");
      manager.del("tempData1");
      manager.del("tempData1"); // Duplicate delete - should be collapsed
      manager.del("tempData2");

      await manager.flush();

      expect(metadataUpdates).toHaveLength(2);

      const update = metadataUpdates[1]!;
      const operations = update.operations!;

      // Should have: 1 collapsed increment, 1 collapsed set, 2 appends, 2 collapsed deletes
      expect(operations).toHaveLength(6);

      // Find each operation type
      const incrementOp = operations.find((op) => op.type === "increment");
      const setOp = operations.find((op) => op.type === "set");
      const appendOps = operations.filter((op) => op.type === "append");
      const deleteOps = operations.filter((op) => op.type === "delete");

      expect(incrementOp).toEqual({
        type: "increment",
        key: "counter",
        value: 8, // 5 + 3
      });

      expect(setOp).toEqual({
        type: "set",
        key: "status",
        value: "completed", // Last set value
      });

      expect(appendOps).toHaveLength(2);
      expect(appendOps[0]).toEqual({
        type: "append",
        key: "logs",
        value: "Started processing",
      });
      expect(appendOps[1]).toEqual({
        type: "append",
        key: "logs",
        value: "Processing completed",
      });

      expect(deleteOps).toHaveLength(2);
      const deleteKeys = deleteOps.map((op) => (op as any).key).sort();
      expect(deleteKeys).toEqual(["tempData1", "tempData2"]);
    });

    test("should collapse operations across different keys independently", async () => {
      // Increment different keys
      manager.increment("filesProcessed", 10);
      manager.increment("errorsCount", 1);
      manager.increment("filesProcessed", 5);
      manager.increment("errorsCount", 2);

      await manager.flush();

      expect(metadataUpdates).toHaveLength(1);

      const update = metadataUpdates[0]!;
      expect(update.operations).toHaveLength(2);

      // Should have separate collapsed increments for each key
      const filesOp = update.operations!.find(
        (op) => op.type === "increment" && (op as any).key === "filesProcessed"
      );
      const errorsOp = update.operations!.find(
        (op) => op.type === "increment" && (op as any).key === "errorsCount"
      );

      expect(filesOp).toEqual({
        type: "increment",
        key: "filesProcessed",
        value: 15, // 10 + 5
      });

      expect(errorsOp).toEqual({
        type: "increment",
        key: "errorsCount",
        value: 3, // 1 + 2
      });
    });

    test("should preserve zero increments after collapsing (filtering happens at enqueue time)", async () => {
      // Increments that cancel out
      manager.increment("balance", 10);
      manager.increment("balance", -5);
      manager.increment("balance", -5);
      manager.set("status", "neutral");

      await manager.flush();

      expect(metadataUpdates).toHaveLength(1);

      const update = metadataUpdates[0]!;
      expect(update.operations).toHaveLength(2); // Increment and set operations

      // Should have collapsed increment with zero value
      const incrementOp = update.operations!.find((op) => op.type === "increment");
      const setOp = update.operations!.find((op) => op.type === "set");

      expect(incrementOp).toEqual({
        type: "increment",
        key: "balance",
        value: 0, // 10 + (-5) + (-5) = 0
      });

      expect(setOp).toEqual({
        type: "set",
        key: "status",
        value: "neutral",
      });
    });

    test("should collapse parent and root operations separately", async () => {
      // Test parent operations
      manager.parent.increment("parentCounter", 3);
      manager.parent.increment("parentCounter", 7);

      // Test root operations
      manager.root.increment("rootCounter", 2);
      manager.root.increment("rootCounter", 8);

      await manager.flush();

      expect(metadataUpdates).toHaveLength(1);

      const update = metadataUpdates[0]!;

      expect(update.parentOperations).toHaveLength(1);
      expect(update.parentOperations![0]).toEqual({
        type: "increment",
        key: "parentCounter",
        value: 10, // 3 + 7
      });

      expect(update.rootOperations).toHaveLength(1);
      expect(update.rootOperations![0]).toEqual({
        type: "increment",
        key: "rootCounter",
        value: 10, // 2 + 8
      });
    });

    describe("sanity checks - collapsed operations produce same results", () => {
      test("should produce same metadata result for collapsed increment operations", () => {
        const initialMetadata = { counter: 5, other: "value" };

        const originalOperations = [
          { type: "increment" as const, key: "counter", value: 2 },
          { type: "increment" as const, key: "counter", value: 3 },
          { type: "increment" as const, key: "counter", value: -1 },
        ];

        // Apply original operations
        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        // Apply collapsed operations
        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        // Results should be identical
        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should produce same metadata result for collapsed set operations", () => {
        const initialMetadata = { status: "initial", other: "value" };

        const originalOperations = [
          { type: "set" as const, key: "status", value: "processing" },
          { type: "set" as const, key: "status", value: "validating" },
          { type: "set" as const, key: "status", value: "completed" },
        ];

        // Apply original operations
        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        // Apply collapsed operations
        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        // Results should be identical
        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should produce same metadata result for collapsed delete operations", () => {
        const initialMetadata = {
          tempData: "value",
          otherData: "keep",
          anotherTemp: "also remove",
        };

        const originalOperations = [
          { type: "delete" as const, key: "tempData" },
          { type: "delete" as const, key: "tempData" }, // Duplicate
          { type: "delete" as const, key: "anotherTemp" },
          { type: "delete" as const, key: "tempData" }, // Another duplicate
        ];

        // Apply original operations
        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        // Apply collapsed operations
        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        // Results should be identical
        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should produce same metadata result for complex mixed operations", () => {
        const initialMetadata = {
          counter: 10,
          status: "initial",
          logs: ["start"],
          tempData: "remove me",
          items: ["item1", "item2"],
        };

        const originalOperations = [
          { type: "increment" as const, key: "counter", value: 5 },
          { type: "set" as const, key: "status", value: "processing" },
          { type: "append" as const, key: "logs", value: "step1" },
          { type: "increment" as const, key: "counter", value: 3 },
          { type: "set" as const, key: "status", value: "validating" },
          { type: "append" as const, key: "logs", value: "step2" },
          { type: "delete" as const, key: "tempData" },
          { type: "remove" as const, key: "items", value: "item1" },
          { type: "increment" as const, key: "counter", value: -2 },
          { type: "set" as const, key: "status", value: "completed" },
          { type: "delete" as const, key: "tempData" }, // Duplicate delete
          { type: "increment" as const, key: "newCounter", value: 1 },
          { type: "increment" as const, key: "newCounter", value: 4 },
        ];

        // Apply original operations
        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        // Apply collapsed operations
        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        // Results should be identical
        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should produce same metadata result when increments cancel out", () => {
        const initialMetadata = { balance: 100, otherValue: "unchanged" };

        const originalOperations = [
          { type: "increment" as const, key: "balance", value: 50 },
          { type: "increment" as const, key: "balance", value: -30 },
          { type: "increment" as const, key: "balance", value: -20 },
          { type: "set" as const, key: "otherValue", value: "changed" },
        ];

        // Apply original operations
        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        // Apply collapsed operations
        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        // Results should be identical
        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should produce same metadata result with JSON path operations", () => {
        const initialMetadata = {
          nested: { counter: 5, status: "init" },
          other: "value",
        };

        const originalOperations = [
          { type: "increment" as const, key: "$.nested.counter", value: 2 },
          { type: "set" as const, key: "$.nested.status", value: "processing" },
          { type: "increment" as const, key: "$.nested.counter", value: 3 },
          { type: "set" as const, key: "$.nested.status", value: "done" },
        ];

        // Apply original operations
        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        // Apply collapsed operations
        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        // Results should be identical
        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should produce same metadata result with large-scale operations (like the original issue)", () => {
        const initialMetadata = {
          filesProcessed: 0,
          status: "starting",
          errors: 0,
          logs: [],
        };

        // Simulate the original issue scenario: processing 1000 files with increment operations
        const originalOperations = [];

        // Add 1000 increment operations for files processed
        for (let i = 0; i < 1000; i++) {
          originalOperations.push({ type: "increment" as const, key: "filesProcessed", value: 1 });
        }

        // Add some error increments
        for (let i = 0; i < 50; i++) {
          originalOperations.push({ type: "increment" as const, key: "errors", value: 1 });
        }

        // Add some status updates (only last one should matter)
        originalOperations.push({ type: "set" as const, key: "status", value: "processing" });
        originalOperations.push({ type: "set" as const, key: "status", value: "validating" });
        originalOperations.push({ type: "set" as const, key: "status", value: "completed" });

        // Add some log entries (should be preserved)
        originalOperations.push({
          type: "append" as const,
          key: "logs",
          value: "Started processing",
        });
        originalOperations.push({
          type: "append" as const,
          key: "logs",
          value: "Finished processing",
        });

        // Apply original operations
        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        // Apply collapsed operations
        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        // Results should be identical
        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);

        // Verify the expected final state
        expect(collapsedResult.newMetadata).toEqual({
          filesProcessed: 1000,
          status: "completed",
          errors: 50,
          logs: ["Started processing", "Finished processing"],
        });
      });
    });

    describe("edge case sanity checks", () => {
      test("should handle operations with zero values correctly", () => {
        const initialMetadata = { counter: 10, other: "value" };

        const originalOperations = [
          { type: "increment" as const, key: "counter", value: 0 }, // Should be no-op
          { type: "increment" as const, key: "counter", value: 5 },
          { type: "increment" as const, key: "counter", value: 0 }, // Should be no-op
          { type: "increment" as const, key: "otherCounter", value: 0 }, // Creates key with 0
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should handle negative increment values correctly", () => {
        const initialMetadata = { balance: 100, score: 50 };

        const originalOperations = [
          { type: "increment" as const, key: "balance", value: -20 },
          { type: "increment" as const, key: "balance", value: -30 },
          { type: "increment" as const, key: "score", value: 10 },
          { type: "increment" as const, key: "score", value: -15 },
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should handle very large numbers correctly", () => {
        const initialMetadata = { bigCounter: 0 };

        const originalOperations = [
          { type: "increment" as const, key: "bigCounter", value: Number.MAX_SAFE_INTEGER },
          { type: "increment" as const, key: "bigCounter", value: -1000000 },
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should handle keys with special characters and unicode", () => {
        const initialMetadata = { "key-with-dashes": 1, "key.with.dots": 2, "🚀emoji": 3 };

        const originalOperations = [
          { type: "increment" as const, key: "key-with-dashes", value: 1 },
          { type: "increment" as const, key: "key.with.dots", value: 2 },
          { type: "increment" as const, key: "🚀emoji", value: 3 },
          { type: "set" as const, key: "unicode-测试", value: "test" },
          { type: "set" as const, key: "unicode-测试", value: "final" },
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should handle deeply nested JSON paths correctly", () => {
        const initialMetadata = {
          level1: {
            level2: {
              level3: {
                counter: 0,
                status: "init",
              },
            },
          },
        };

        const originalOperations = [
          { type: "increment" as const, key: "$.level1.level2.level3.counter", value: 1 },
          { type: "increment" as const, key: "$.level1.level2.level3.counter", value: 2 },
          { type: "set" as const, key: "$.level1.level2.level3.status", value: "processing" },
          { type: "set" as const, key: "$.level1.level2.level3.status", value: "done" },
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should handle operations with null and undefined values", () => {
        const initialMetadata = { existingKey: "value", nullKey: null };

        const originalOperations = [
          { type: "set" as const, key: "nullKey", value: "not null" },
          { type: "set" as const, key: "nullKey", value: null },
          { type: "set" as const, key: "newKey", value: "defined" },
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should handle operations with complex nested objects and arrays", () => {
        const initialMetadata = {
          config: { enabled: true, retries: 3 },
          items: [{ id: 1, name: "first" }],
        };

        const originalOperations: Array<
          { type: "set"; key: string; value: any } | { type: "append"; key: string; value: any }
        > = [
          { type: "set", key: "config", value: { enabled: false, retries: 5, timeout: 30 } },
          { type: "set", key: "config", value: { enabled: true, retries: 10 } },
          { type: "append", key: "items", value: { id: 2, name: "second" } },
          { type: "append", key: "items", value: { id: 3, name: "third" } },
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should handle conflicting operations (set then delete)", () => {
        const initialMetadata = { temp: "initial", keep: "value" };

        const originalOperations = [
          { type: "set" as const, key: "temp", value: "updated" },
          { type: "set" as const, key: "temp", value: "updated again" },
          { type: "delete" as const, key: "temp" }, // This should win
          { type: "set" as const, key: "newKey", value: "created" },
          { type: "delete" as const, key: "newKey" }, // This should win over the set
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should handle operations on non-existent nested paths", () => {
        const initialMetadata = { existing: "value" };

        const originalOperations = [
          { type: "increment" as const, key: "$.nonexistent.path.counter", value: 1 },
          { type: "increment" as const, key: "$.nonexistent.path.counter", value: 2 },
          { type: "set" as const, key: "$.another.missing.path", value: "created" },
          { type: "set" as const, key: "$.another.missing.path", value: "updated" },
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should handle boolean and mixed type operations", () => {
        const initialMetadata = { flag: false, count: 0, text: "start" };

        const originalOperations = [
          { type: "set" as const, key: "flag", value: true },
          { type: "set" as const, key: "flag", value: false },
          { type: "increment" as const, key: "count", value: 1.5 }, // Float increment
          { type: "increment" as const, key: "count", value: 2.5 },
          { type: "set" as const, key: "text", value: 123 }, // Type change
          { type: "set" as const, key: "text", value: "end" }, // Type change back
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should handle very long key names", () => {
        const longKey = "a".repeat(1000); // Very long key name
        const initialMetadata = { [longKey]: 0, normal: "value" };

        const originalOperations = [
          { type: "increment" as const, key: longKey, value: 1 },
          { type: "increment" as const, key: longKey, value: 2 },
          { type: "increment" as const, key: longKey, value: 3 },
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });

      test("should handle empty arrays and objects correctly", () => {
        const initialMetadata = { emptyArray: [], emptyObject: {} };

        const originalOperations: Array<
          { type: "append"; key: string; value: any } | { type: "set"; key: string; value: any }
        > = [
          { type: "append", key: "emptyArray", value: "first" },
          { type: "append", key: "emptyArray", value: "second" },
          { type: "set", key: "emptyObject", value: { key: "value" } },
          { type: "set", key: "emptyObject", value: {} }, // Back to empty
        ];

        const originalResult = applyMetadataOperations(initialMetadata, originalOperations);

        // Use the actual collapseOperations function
        const collapsedOperations = collapseOperations(originalOperations);

        const collapsedResult = applyMetadataOperations(initialMetadata, collapsedOperations);

        expect(collapsedResult.newMetadata).toEqual(originalResult.newMetadata);
        expect(collapsedResult.unappliedOperations).toEqual(originalResult.unappliedOperations);
      });
    });
  });
});
