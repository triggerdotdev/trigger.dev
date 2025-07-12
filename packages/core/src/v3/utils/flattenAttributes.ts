import { Attributes } from "@opentelemetry/api";

export const NULL_SENTINEL = "$@null((";
export const CIRCULAR_REFERENCE_SENTINEL = "$@circular((";

export function flattenAttributes(
  obj: unknown,
  prefix?: string,
  maxAttributeCount?: number
): Attributes {
  const flattener = new AttributeFlattener(maxAttributeCount);
  flattener.doFlatten(obj, prefix);
  return flattener.attributes;
}

class AttributeFlattener {
  private seen: WeakSet<object> = new WeakSet();
  private attributeCounter: number = 0;
  private result: Attributes = {};

  constructor(private maxAttributeCount?: number) {}

  get attributes(): Attributes {
    return this.result;
  }

  private canAddMoreAttributes(): boolean {
    return this.maxAttributeCount === undefined || this.attributeCounter < this.maxAttributeCount;
  }

  private addAttribute(key: string, value: any): boolean {
    if (!this.canAddMoreAttributes()) {
      return false;
    }
    this.result[key] = value;
    this.attributeCounter++;
    return true;
  }

  doFlatten(obj: unknown, prefix?: string) {
    if (!this.canAddMoreAttributes()) {
      return;
    }

    // Check if obj is null or undefined
    if (obj === undefined) {
      return;
    }

    if (obj === null) {
      this.addAttribute(prefix || "", NULL_SENTINEL);
      return;
    }

    if (typeof obj === "string") {
      this.addAttribute(prefix || "", obj);
      return;
    }

    if (typeof obj === "number") {
      this.addAttribute(prefix || "", obj);
      return;
    }

    if (typeof obj === "boolean") {
      this.addAttribute(prefix || "", obj);
      return;
    }

    if (obj instanceof Date) {
      this.addAttribute(prefix || "", obj.toISOString());
      return;
    }

    // Handle Error objects
    if (obj instanceof Error) {
      this.addAttribute(`${prefix || "error"}.name`, obj.name);
      this.addAttribute(`${prefix || "error"}.message`, obj.message);
      if (obj.stack) {
        this.addAttribute(`${prefix || "error"}.stack`, obj.stack);
      }
      return;
    }

    // Handle functions
    if (typeof obj === "function") {
      const funcName = obj.name || "anonymous";
      this.addAttribute(prefix || "", `[Function: ${funcName}]`);
      return;
    }

    // Handle Set objects
    if (obj instanceof Set) {
      let index = 0;
      for (const item of obj) {
        if (!this.canAddMoreAttributes()) break;
        this.#processValue(item, `${prefix || "set"}.[${index}]`);
        index++;
      }
      return;
    }

    // Handle Map objects
    if (obj instanceof Map) {
      for (const [key, value] of obj) {
        if (!this.canAddMoreAttributes()) break;
        // Use the key directly if it's a string, otherwise convert it
        const keyStr = typeof key === "string" ? key : String(key);
        this.#processValue(value, `${prefix || "map"}.${keyStr}`);
      }
      return;
    }

    // Handle File objects
    if (typeof File !== "undefined" && obj instanceof File) {
      this.addAttribute(`${prefix || "file"}.name`, obj.name);
      this.addAttribute(`${prefix || "file"}.size`, obj.size);
      this.addAttribute(`${prefix || "file"}.type`, obj.type);
      this.addAttribute(`${prefix || "file"}.lastModified`, obj.lastModified);
      return;
    }

    // Handle ReadableStream objects
    if (typeof ReadableStream !== "undefined" && obj instanceof ReadableStream) {
      this.addAttribute(`${prefix || "stream"}.type`, "ReadableStream");
      this.addAttribute(`${prefix || "stream"}.locked`, obj.locked);
      return;
    }

    // Handle WritableStream objects
    if (typeof WritableStream !== "undefined" && obj instanceof WritableStream) {
      this.addAttribute(`${prefix || "stream"}.type`, "WritableStream");
      this.addAttribute(`${prefix || "stream"}.locked`, obj.locked);
      return;
    }

    // Handle Promise objects
    if (obj instanceof Promise) {
      this.addAttribute(prefix || "promise", "[Promise object]");
      // We can't inspect promise state synchronously, so just indicate it's a promise
      return;
    }

    // Handle RegExp objects
    if (obj instanceof RegExp) {
      this.addAttribute(`${prefix || "regexp"}.source`, obj.source);
      this.addAttribute(`${prefix || "regexp"}.flags`, obj.flags);
      return;
    }

    // Handle URL objects
    if (typeof URL !== "undefined" && obj instanceof URL) {
      this.addAttribute(`${prefix || "url"}.href`, obj.href);
      this.addAttribute(`${prefix || "url"}.protocol`, obj.protocol);
      this.addAttribute(`${prefix || "url"}.host`, obj.host);
      this.addAttribute(`${prefix || "url"}.pathname`, obj.pathname);
      return;
    }

    // Handle ArrayBuffer and TypedArrays
    if (obj instanceof ArrayBuffer) {
      this.addAttribute(`${prefix || "arraybuffer"}.byteLength`, obj.byteLength);
      return;
    }

    // Handle TypedArrays (Uint8Array, Int32Array, etc.)
    if (ArrayBuffer.isView(obj)) {
      const typedArray = obj as any;
      this.addAttribute(`${prefix || "typedarray"}.constructor`, typedArray.constructor.name);
      this.addAttribute(`${prefix || "typedarray"}.length`, typedArray.length);
      this.addAttribute(`${prefix || "typedarray"}.byteLength`, typedArray.byteLength);
      this.addAttribute(`${prefix || "typedarray"}.byteOffset`, typedArray.byteOffset);
      return;
    }

    // Check for circular reference
    if (obj !== null && typeof obj === "object" && this.seen.has(obj)) {
      this.addAttribute(prefix || "", CIRCULAR_REFERENCE_SENTINEL);
      return;
    }

    // Add object to seen set
    if (obj !== null && typeof obj === "object") {
      this.seen.add(obj);
    }

    for (const [key, value] of Object.entries(obj)) {
      if (!this.canAddMoreAttributes()) {
        break;
      }

      const newPrefix = `${prefix ? `${prefix}.` : ""}${Array.isArray(obj) ? `[${key}]` : key}`;

      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (!this.canAddMoreAttributes()) {
            break;
          }
          this.#processValue(value[i], `${newPrefix}.[${i}]`);
        }
      } else {
        this.#processValue(value, newPrefix);
      }
    }
  }

  #processValue(value: unknown, prefix: string) {
    if (!this.canAddMoreAttributes()) {
      return;
    }

    // Handle primitive values directly
    if (value === null) {
      this.addAttribute(prefix, NULL_SENTINEL);
      return;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      this.addAttribute(prefix, value);
      return;
    }

    // Handle non-primitive values by recursing
    if (typeof value === "object" || typeof value === "function") {
      this.doFlatten(value as any, prefix);
    } else {
      // Convert other types to strings (bigint, symbol, etc.)
      this.addAttribute(prefix, String(value));
    }
  }
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
      current[lastPart] = rehydrateNull(rehydrateCircular(value));
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

function rehydrateNull(value: any): any {
  if (value === NULL_SENTINEL) {
    return null;
  }

  return value;
}
