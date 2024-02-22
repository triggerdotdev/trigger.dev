import { Attributes } from "@opentelemetry/api";

export function flattenAttributes(
  obj: Record<string, unknown> | Array<unknown> | string | boolean | number | null | undefined,
  prefix?: string
): Attributes {
  const result: Attributes = {};

  // Check if obj is null or undefined
  if (obj == null) {
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

  for (const [key, value] of Object.entries(obj)) {
    const newPrefix = `${prefix ? `${prefix}.` : ""}${key}`;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === "object" && value[i] !== null) {
          // update null check here as well
          Object.assign(result, flattenAttributes(value[i], `${newPrefix}.${i}`));
        } else {
          result[`${newPrefix}.${i}`] = value[i];
        }
      }
    } else if (isRecord(value)) {
      // update null check here
      Object.assign(result, flattenAttributes(value, newPrefix));
    } else {
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        result[newPrefix] = value;
      }
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unflattenAttributes(obj: Attributes): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const parts = key.split(".");
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];

      // Check if part is not undefined and it's a string.
      if (typeof part === "string") {
        if (current[part] == null) {
          current[part] = {};
        }

        current = current[part] as Record<string, unknown>;
      }
    }
    // For the last element, we must ensure we also check if it is not undefined and it's a string.
    const lastPart = parts[parts.length - 1];
    if (typeof lastPart === "string") {
      current[lastPart] = value;
    }
  }

  return result;
}
