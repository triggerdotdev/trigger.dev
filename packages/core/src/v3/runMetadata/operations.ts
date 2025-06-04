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

  const collapsed: RunMetadataChangeOperation[] = [];
  let i = 0;
  while (i < operations.length) {
    const op = operations[i];
    if (!op) {
      i++;
      continue;
    }

    // Collapse consecutive increments on the same key
    if (op.type === "increment") {
      let sum = op.value;
      let j = i + 1;
      while (
        j < operations.length &&
        operations[j]?.type === "increment" &&
        (operations[j] as typeof op)?.key === op.key
      ) {
        sum += (operations[j] as typeof op).value;
        j++;
      }
      collapsed.push({ type: "increment", key: op.key, value: sum });
      i = j;
      continue;
    }

    // Collapse consecutive sets on the same key (keep only the last in the sequence)
    if (op.type === "set") {
      let last = op;
      let j = i + 1;
      while (
        j < operations.length &&
        operations[j]?.type === "set" &&
        (operations[j] as typeof op)?.key === op.key
      ) {
        last = operations[j] as typeof op;
        j++;
      }
      collapsed.push(last);
      i = j;
      continue;
    }

    // Collapse consecutive deletes on the same key (keep only one)
    if (op.type === "delete") {
      let j = i + 1;
      while (
        j < operations.length &&
        operations[j]?.type === "delete" &&
        (operations[j] as typeof op)?.key === op.key
      ) {
        j++;
      }
      collapsed.push(op);
      i = j;
      continue;
    }

    // For append, remove, update, and unknown types, preserve order and do not collapse
    collapsed.push(op);
    i++;
  }

  return collapsed;
}
