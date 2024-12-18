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
            unappliedOperations.push(operation);
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
