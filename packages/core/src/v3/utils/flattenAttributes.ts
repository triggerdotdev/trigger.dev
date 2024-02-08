import { Attributes } from "@opentelemetry/api";

export function flattenAttributes(
  obj: Record<string, unknown> | null | undefined,
  prefix?: string
): Attributes {
  const result: Attributes = {};

  // Check if obj is null or undefined
  if (obj == null) {
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
