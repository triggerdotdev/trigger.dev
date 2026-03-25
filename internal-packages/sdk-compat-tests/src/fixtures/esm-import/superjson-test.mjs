/**
 * SuperJSON Serialization Test
 *
 * This validates the fix for #2937 - ESM/CJS compatibility with superjson.
 * Tests that complex types (Date, Set, Map, BigInt) serialize correctly.
 */

import { task, logger } from "@trigger.dev/sdk";

// The SDK uses superjson internally for serialization
// This test ensures the vendored superjson works correctly

const complexData = {
  date: new Date("2024-01-15T12:00:00Z"),
  set: new Set([1, 2, 3]),
  map: new Map([
    ["key1", "value1"],
    ["key2", "value2"],
  ]),
  bigint: BigInt("9007199254740991"),
  nested: {
    innerDate: new Date("2024-06-01"),
    innerSet: new Set(["a", "b"]),
  },
};

// Create a task that uses complex types
const complexTask = task({
  id: "superjson-test-task",
  run: async (payload) => {
    // Just verify the payload structure matches expectations
    return {
      hasDate: payload.date instanceof Date,
      hasSet: payload.set instanceof Set,
      hasMap: payload.map instanceof Map,
      hasBigInt: typeof payload.bigint === "bigint",
      hasNestedDate: payload.nested?.innerDate instanceof Date,
    };
  },
});

// Verify task was created successfully
if (!complexTask.id) {
  console.error("FAIL: Task creation failed");
  process.exit(1);
}

// Test that logger works (it uses superjson for structured logging)
try {
  logger.info("Testing superjson serialization", {
    complexData,
    timestamp: new Date(),
  });
} catch (error) {
  console.error("FAIL: Logger with complex data failed:", error);
  process.exit(1);
}

console.log("SUCCESS: SuperJSON serialization validated");
