import type { JSONSchema } from "@trigger.dev/core/v3";
import * as z4 from "zod/v4/core";
import type { ConversionOptions } from "./index.js";

type Zod4Converter = {
  version: { major: number; minor: number };
  toJSONSchema: (schema: any, options: any) => unknown;
};

export function convertZod4Schema(
  schema: any,
  options?: ConversionOptions,
  converter: Zod4Converter = z4
): JSONSchema | undefined {
  const useReferences = options?.useReferences ?? false;
  const supportsUnrepresentableHandler =
    converter.version.major > 4 || (converter.version.major === 4 && converter.version.minor >= 5);

  return converter.toJSONSchema(schema, {
    target: "draft-7",
    io: "output",
    reused: useReferences ? "ref" : "inline",
    unrepresentable: supportsUnrepresentableHandler
      ? ({ zodSchema }: { zodSchema: z4.$ZodTypes }) =>
          zodSchema._zod.def.type === "date" ? { type: "string", format: "date-time" } : "throw"
      : "any",
    override: ({ zodSchema, jsonSchema }: { zodSchema: z4.$ZodTypes; jsonSchema: any }) => {
      const def = zodSchema._zod.def;

      if (!supportsUnrepresentableHandler) {
        enforceLegacyUnrepresentableTypes(def, jsonSchema);
      }

      if (def.type === "date") {
        jsonSchema.type = "string";
        jsonSchema.format = "date-time";
      }

      if (def.type === "undefined") {
        throw new Error("Undefined cannot be represented in JSON Schema");
      }

      if (def.type === "object" && jsonSchema.required) {
        const required = jsonSchema.required.filter((key: string) => {
          const field = def.shape[key];
          return !field || field._zod.optout === "optional" || !hasOptionalOutput(field);
        });
        if (required.length > 0) {
          jsonSchema.required = required;
        } else {
          delete jsonSchema.required;
        }
      }
    },
  }) as JSONSchema;
}

function enforceLegacyUnrepresentableTypes(def: any, jsonSchema: Record<string, unknown>) {
  switch (def.type) {
    case "bigint":
      throw new Error("BigInt cannot be represented in JSON Schema");
    case "symbol":
      throw new Error("Symbols cannot be represented in JSON Schema");
    case "void":
      throw new Error("Void cannot be represented in JSON Schema");
    case "map":
      throw new Error("Map cannot be represented in JSON Schema");
    case "set":
      throw new Error("Set cannot be represented in JSON Schema");
    case "transform":
      throw new Error("Transforms cannot be represented in JSON Schema");
    case "nan":
      throw new Error("NaN cannot be represented in JSON Schema");
    case "custom":
      throw new Error("Custom types cannot be represented in JSON Schema");
    case "function":
      throw new Error("Function types cannot be represented in JSON Schema");
    case "literal": {
      if (def.values.some((value: unknown) => value === undefined)) {
        throw new Error("Literal `undefined` cannot be represented in JSON Schema");
      }
      if (def.values.some((value: unknown) => typeof value === "bigint")) {
        throw new Error("BigInt literals cannot be represented in JSON Schema");
      }
      return;
    }
    case "catch": {
      if ("default" in jsonSchema) return;
      try {
        def.catchValue(undefined);
      } catch {
        throw new Error("Dynamic catch values are not supported in JSON Schema");
      }
    }
  }
}

function hasOptionalOutput(schema: z4.$ZodType, seen = new Set<z4.$ZodType>()): boolean {
  if (schema._zod.optout === "optional") return true;
  if (seen.has(schema)) return false;
  seen.add(schema);

  const def = (schema as z4.$ZodTypes)._zod.def;
  switch (def.type) {
    case "union":
      return def.options.some((option) => hasOptionalOutput(option, seen));
    case "nullable":
    case "readonly":
    case "catch":
      return hasOptionalOutput(def.innerType, seen);
    case "lazy":
      return hasOptionalOutput(def.getter(), seen);
    case "pipe":
      return hasOptionalOutput(def.out, seen);
    default:
      return false;
  }
}
