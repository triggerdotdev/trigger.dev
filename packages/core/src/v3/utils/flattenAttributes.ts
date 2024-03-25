import { Attributes } from "@opentelemetry/api";

export function flattenAttributes(
  obj: Record<string, unknown> | Array<unknown> | string | boolean | number | null | undefined,
  prefix?: string
): Attributes {
  const result: Attributes = {};

  // Check if obj is null or undefined
  if (!obj) {
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
          Object.assign(result, flattenAttributes(value[i], `${newPrefix}.[${i}]`));
        } else {
          result[`${newPrefix}.[${i}]`] = value[i];
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
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return obj;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const parts = key.split(".").reduce((acc, part) => {
      // Splitting array indices as separate parts
      if (detectIsArrayIndex(part)) {
        acc.push(part);
      } else {
        acc.push(...part.split(/\.\[(.*?)\]/).filter(Boolean));
      }
      return acc;
    }, [] as string[]);

    let current: Record<string, unknown> = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const isArray = detectIsArrayIndex(part);
      const cleanPart = isArray ? part.substring(1, part.length - 1) : part;
      const nextIsArray = detectIsArrayIndex(parts[i + 1]);
      if (!current[cleanPart]) {
        current[cleanPart] = nextIsArray ? [] : {};
      }
      current = current[cleanPart] as Record<string, unknown>;
    }
    const lastPart = parts[parts.length - 1];
    const cleanLastPart = detectIsArrayIndex(lastPart)
      ? parseInt(lastPart.substring(1, lastPart.length - 1), 10)
      : lastPart;
    current[cleanLastPart] = value;
  }

  return result;
}

function detectIsArrayIndex(key: string): boolean {
  const match = key.match(/^\[(\d+)\]$/);

  if (match) {
    return true;
  }

  return false;
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
