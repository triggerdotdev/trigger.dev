import { Attributes } from "@opentelemetry/api";

export const NULL_SENTINEL = "$@null((";

export function flattenAttributes(
  obj: Record<string, unknown> | Array<unknown> | string | boolean | number | null | undefined,
  prefix?: string
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
    const newPrefix = `${prefix ? `${prefix}.` : ""}${Array.isArray(obj) ? `[${key}]` : key}`;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === "object" && value[i] !== null) {
          // update null check here as well
          Object.assign(result, flattenAttributes(value[i], `${newPrefix}.[${i}]`));
        } else {
          if (value[i] === null) {
            result[`${newPrefix}.[${i}]`] = NULL_SENTINEL;
          } else {
            result[`${newPrefix}.[${i}]`] = value[i];
          }
        }
      }
    } else if (isRecord(value)) {
      // update null check here
      Object.assign(result, flattenAttributes(value, newPrefix));
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
    return rehydrateNull(obj[""]) as any;
  }

  if (Object.keys(obj).length === 0) {
    return;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const parts = key.split(".").reduce((acc, part) => {
      if (part.includes("[")) {
        // Handling nested array indices
        const subparts = part.split(/\[|\]/).filter((p) => p !== "");
        acc.push(...subparts);
      } else {
        acc.push(part);
      }
      return acc;
    }, [] as string[]);

    let current: any = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const nextPart = parts[i + 1];
      const isArray = /^\d+$/.test(nextPart);
      if (isArray && !Array.isArray(current[part])) {
        current[part] = [];
      } else if (!isArray && current[part] === undefined) {
        current[part] = {};
      }
      current = current[part];
    }
    const lastPart = parts[parts.length - 1];
    current[lastPart] = rehydrateNull(value);
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

function rehydrateNull(value: any): any {
  if (value === NULL_SENTINEL) {
    return null;
  }

  return value;
}
