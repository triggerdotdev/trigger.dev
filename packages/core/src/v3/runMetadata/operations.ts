import { JSONHeroPath } from "@jsonhero/path";
import { RunMetadataChangeOperation } from "../schemas/common.js";
import { dequal } from "dequal";

export type ApplyOperationResult = {
  newMetadata: Record<string, unknown>;
  unappliedOperations: RunMetadataChangeOperation[];
};

export function applyMetadataOperations(
  currentMetadata: Record<string, unknown>,
  operations: RunMetadataChangeOperation | RunMetadataChangeOperation[]
): ApplyOperationResult {
  const unappliedOperations: RunMetadataChangeOperation[] = [];
  // Start with a mutable copy of the current metadata
  let newMetadata: Record<string, unknown> = structuredClone(currentMetadata);

  for (const operation of Array.isArray(operations) ? operations : [operations]) {
    switch (operation.type) {
      case "set": {
        if (operation.key.startsWith("$.")) {
          const path = new JSONHeroPath(operation.key);
          path.set(newMetadata, operation.value);
        } else {
          // Set the value directly
          newMetadata[operation.key] = operation.value;
        }

        break;
      }

      case "delete": {
        // Safely delete the key if it exists
        if (operation.key in newMetadata) {
          delete newMetadata[operation.key];
        }
        break;
      }

      case "append": {
        if (operation.key.startsWith("$.")) {
          const path = new JSONHeroPath(operation.key);
          const currentValue = path.first(newMetadata);

          if (currentValue === undefined) {
            // Initialize as array with single item
            path.set(newMetadata, [operation.value]);
          } else if (Array.isArray(currentValue)) {
            // Append to existing array
            path.set(newMetadata, [...currentValue, operation.value]);
          } else {
            // Convert to array if not already
            path.set(newMetadata, [currentValue, operation.value]);
          }
        } else {
          // Ensure the value at key is an array or initialize as an array
          const existingValue = newMetadata[operation.key];
          if (Array.isArray(existingValue)) {
            existingValue.push(operation.value);
          } else if (existingValue === undefined) {
            newMetadata[operation.key] = [operation.value];
          } else {
            // Convert to array if not already
            newMetadata[operation.key] = [existingValue, operation.value];
          }
        }

        break;
      }

      case "remove": {
        if (operation.key.startsWith("$.")) {
          const path = new JSONHeroPath(operation.key);
          const currentValue = path.first(newMetadata);

          if (Array.isArray(currentValue)) {
            // Remove the value from array using deep equality check
            const newArray = currentValue.filter((item) => !dequal(item, operation.value));
            path.set(newMetadata, newArray);
          } else {
            unappliedOperations.push(operation);
          }
        } else {
          // Remove matching values if the key points to an array
          const existingValue = newMetadata[operation.key];

          if (Array.isArray(existingValue)) {
            newMetadata[operation.key] = existingValue.filter(
              (item) => !dequal(item, operation.value)
            );
          } else {
            unappliedOperations.push(operation);
          }
        }

        break;
      }

      case "increment": {
        let currentValue = operation.key.startsWith("$.")
          ? new JSONHeroPath(operation.key).first(newMetadata)
          : newMetadata[operation.key];

        const newValue = (typeof currentValue === "number" ? currentValue : 0) + operation.value;

        if (operation.key.startsWith("$.")) {
          new JSONHeroPath(operation.key).set(newMetadata, newValue);
        } else {
          newMetadata[operation.key] = newValue;
        }

        break;
      }

      case "update": {
        // Update the metadata object with the new object
        newMetadata = operation.value;
        break;
      }

      default: {
        // Log unsupported operation type
        unappliedOperations.push(operation);
        break;
      }
    }
  }

  return { newMetadata, unappliedOperations };
}

/**
 * Collapses metadata operations to reduce payload size and avoid 413 "Request Entity Too Large" errors.
 *
 * When there are many operations queued up (e.g., 10k increment operations), sending them all
 * individually can result in request payloads exceeding the server's 1MB limit. This function
 * intelligently combines operations where possible to reduce the payload size:
 *
 * - **Increment operations**: Multiple increments on the same key are summed into a single increment
 *   - Example: increment("counter", 1) + increment("counter", 2) → increment("counter", 3)
 *
 * - **Set operations**: Multiple sets on the same key keep only the last one (since later sets override earlier ones)
 *   - Example: set("status", "processing") + set("status", "done") → set("status", "done")
 *
 * - **Delete operations**: Multiple deletes on the same key keep only one (duplicates are redundant)
 *   - Example: del("temp") + del("temp") → del("temp")
 *
 * - **Append, remove, and update operations**: Preserved as-is to maintain correctness since order matters
 *
 * @param operations Array of metadata change operations to collapse
 * @returns Collapsed array with fewer operations that produce the same final result
 *
 * @example
 * ```typescript
 * const operations = [
 *   { type: "increment", key: "counter", value: 1 },
 *   { type: "increment", key: "counter", value: 2 },
 *   { type: "set", key: "status", value: "processing" },
 *   { type: "set", key: "status", value: "done" }
 * ];
 *
 * const collapsed = collapseOperations(operations);
 * // Result: [
 * //   { type: "increment", key: "counter", value: 3 },
 * //   { type: "set", key: "status", value: "done" }
 * // ]
 * ```
 */
export function collapseOperations(
  operations: RunMetadataChangeOperation[]
): RunMetadataChangeOperation[] {
  if (operations.length === 0) {
    return operations;
  }

  // Maps to track collapsible operations
  const incrementsByKey = new Map<string, number>();
  const setsByKey = new Map<string, RunMetadataChangeOperation>();
  const deletesByKey = new Set<string>();
  const preservedOperations: RunMetadataChangeOperation[] = [];

  // Process operations in order
  for (const operation of operations) {
    switch (operation.type) {
      case "increment": {
        const currentIncrement = incrementsByKey.get(operation.key) || 0;
        incrementsByKey.set(operation.key, currentIncrement + operation.value);
        break;
      }
      case "set": {
        // Keep only the last set operation for each key
        setsByKey.set(operation.key, operation);
        break;
      }
      case "delete": {
        // Keep only one delete operation per key
        deletesByKey.add(operation.key);
        break;
      }
      case "append":
      case "remove":
      case "update": {
        // Preserve these operations as-is to maintain correctness
        preservedOperations.push(operation);
        break;
      }
      default: {
        // Handle any future operation types by preserving them
        preservedOperations.push(operation);
        break;
      }
    }
  }

  // Build the collapsed operations array
  const collapsedOperations: RunMetadataChangeOperation[] = [];

  // Add collapsed increment operations
  for (const [key, value] of incrementsByKey) {
    collapsedOperations.push({ type: "increment", key, value });
  }

  // Add collapsed set operations
  for (const operation of setsByKey.values()) {
    collapsedOperations.push(operation);
  }

  // Add collapsed delete operations
  for (const key of deletesByKey) {
    collapsedOperations.push({ type: "delete", key });
  }

  // Add preserved operations
  collapsedOperations.push(...preservedOperations);

  return collapsedOperations;
}
