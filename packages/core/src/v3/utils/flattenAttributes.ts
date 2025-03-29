import { Attributes } from "@opentelemetry/api";
import { debug } from "node:util";

export const NULL_SENTINEL = "$@null((";
export const EMPTY_ARRAY_SENTINEL = "$@empty_array((";
export const CIRCULAR_REFERENCE_SENTINEL = "$@circular((";

export function flattenAttributes(
  obj: Record<string, unknown> | Array<unknown> | string | boolean | number | null | undefined,
  prefix?: string,
  seen: WeakSet<object> = new WeakSet()
): Attributes {
  const result: Attributes = {};

  // Check if obj is null or undefined
  if (obj === undefined) {
    return result;
  }

  if (obj === null) {
    result[prefix || ""] = NULL_SENTINEL;
    return result;
  }

  if (Array.isArray(obj) && obj.length === 0) {
    result[prefix || ""] = EMPTY_ARRAY_SENTINEL;
    return result;
  }

  if (typeof obj === "string") {
    result[prefix || ""] = obj;
    return result;
  }

  if (typeof obj === "number") {
    result[prefix || ""] = obj;
    return result;
  }

  if (typeof obj === "boolean") {
    result[prefix || ""] = obj;
    return result;
  }

  if (obj instanceof Date) {
    result[prefix || ""] = obj.toISOString();
    return result;
  }

  // Check for circular reference
  if (obj !== null && typeof obj === "object" && seen.has(obj)) {
    result[prefix || ""] = CIRCULAR_REFERENCE_SENTINEL;
    return result;
  }

  // Add object to seen set
  if (obj !== null && typeof obj === "object") {
    seen.add(obj);
  }

  for (const [key, value] of Object.entries(obj)) {
    const newPrefix = `${prefix ? `${prefix}.` : ""}${Array.isArray(obj) ? `[${key}]` : key}`;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === "object" && value[i] !== null) {
          // update null check here as well
          Object.assign(result, flattenAttributes(value[i], `${newPrefix}.[${i}]`, seen));
        } else {
          if (value[i] === null) {
            result[`${newPrefix}.[${i}]`] = NULL_SENTINEL;
          } else {
            result[`${newPrefix}.[${i}]`] = value[i];
          }
        }
      }

      if (!value.length) {
        result[newPrefix] = EMPTY_ARRAY_SENTINEL;
      }
    } else if (isRecord(value)) {
      // update null check here
      Object.assign(result, flattenAttributes(value, newPrefix, seen));
    } else {
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        result[newPrefix] = value;
      } else if (value === null) {
        result[newPrefix] = NULL_SENTINEL;
      }
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unflattenAttributes(
  obj: Attributes
): Record<string, unknown> | string | number | boolean | null | undefined {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return obj;
  }

  if (
    typeof obj === "object" &&
    obj !== null &&
    Object.keys(obj).length === 1 &&
    Object.keys(obj)[0] === ""
  ) {
    return rehydrateEmptyValues(obj[""]) as any;
  }

  if (Object.keys(obj).length === 0) {
    return;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const parts = key.split(".").reduce(
      (acc, part) => {
        if (part.startsWith("[") && part.endsWith("]")) {
          // Handle array indices more precisely
          const match = part.match(/^\[(\d+)\]$/);
          if (match && match[1]) {
            acc.push(parseInt(match[1]));
          } else {
            // Remove brackets for non-numeric array keys
            acc.push(part.slice(1, -1));
          }
        } else {
          acc.push(part);
        }
        return acc;
      },
      [] as (string | number)[]
    );

    let current: any = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const nextPart = parts[i + 1];

      if (!part && part !== 0) {
        continue;
      }

      if (typeof nextPart === "number") {
        // Ensure we create an array for numeric indices
        current[part] = Array.isArray(current[part]) ? current[part] : [];
      } else if (current[part] === undefined) {
        // Create an object for non-numeric paths
        current[part] = {};
      }

      current = current[part];
    }

    const lastPart = parts[parts.length - 1];

    if (lastPart !== undefined) {
      current[lastPart] = rehydrateEmptyValues(rehydrateCircular(value));
    }
  }

  // Convert the result to an array if all top-level keys are numeric indices
  if (Object.keys(result).every((k) => /^\d+$/.test(k))) {
    const maxIndex = Math.max(...Object.keys(result).map((k) => parseInt(k)));
    const arrayResult = Array(maxIndex + 1);
    for (const key in result) {
      arrayResult[parseInt(key)] = result[key];
    }
    return arrayResult as any;
  }

  return result;
}

function rehydrateCircular(value: any): any {
  if (value === CIRCULAR_REFERENCE_SENTINEL) {
    return "[Circular Reference]";
  }
  return value;
}

export function primitiveValueOrflattenedAttributes(
  obj: Record<string, unknown> | Array<unknown> | string | boolean | number | undefined,
  prefix: string | undefined
): Attributes | string | number | boolean | undefined {
  if (
    typeof obj === "string" ||
    typeof obj === "number" ||
    typeof obj === "boolean" ||
    obj === null ||
    obj === undefined
  ) {
    return obj;
  }

  const attributes = flattenAttributes(obj, prefix);

  if (
    prefix !== undefined &&
    typeof attributes[prefix] !== "undefined" &&
    attributes[prefix] !== null
  ) {
    return attributes[prefix] as unknown as Attributes;
  }

  return attributes;
}

function rehydrateEmptyValues(value: any): any {
  if (value === NULL_SENTINEL) {
    return null;
  }

  if (value === EMPTY_ARRAY_SENTINEL) {
    return [];
  }

  return value;
}
