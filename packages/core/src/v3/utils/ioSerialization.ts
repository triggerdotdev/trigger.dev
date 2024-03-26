import { Attributes } from "@opentelemetry/api";
import { deserialize, parse, stringify } from "superjson";
import { SemanticInternalAttributes } from "../semanticInternalAttributes";
import { flattenAttributes } from "./flattenAttributes";
import { imposeAttributeLimits } from "../limits";

export type OutputParseable = {
  output?: string | undefined;
  outputType: string;
};

export function parseOutput(value: OutputParseable): any {
  if (!value.output) {
    return undefined;
  }

  switch (value.outputType) {
    case "application/json":
      return JSON.parse(value.output);
    case "application/super+json":
      return parse(value.output);
    case "text/plain":
      return value.output;
    default:
      return value.output;
  }
}

export function stringifyOutput(value: any): OutputParseable {
  if (value === undefined) {
    return { outputType: "application/json" };
  }

  if (typeof value === "string") {
    return { output: value, outputType: "text/plain" };
  }

  return { output: stringify(value), outputType: "application/super+json" };
}

export function createOutputAttributes(output: OutputParseable): Attributes {
  if (!output.output) {
    return {};
  }

  switch (output.outputType) {
    case "application/json":
      return {
        ...flattenAttributes(output, SemanticInternalAttributes.OUTPUT),
        [SemanticInternalAttributes.OUTPUT_TYPE]: output.outputType,
      };
    case "application/super+json":
      const parsed = parse(output.output) as any;
      const jsonified = JSON.parse(JSON.stringify(parsed, safeReplacer));

      return {
        ...flattenAttributes(jsonified, SemanticInternalAttributes.OUTPUT),
        [SemanticInternalAttributes.OUTPUT_TYPE]: "application/json",
      };
    case "text/plain":
      return {
        [SemanticInternalAttributes.OUTPUT]: output.output,
        [SemanticInternalAttributes.OUTPUT_TYPE]: output.outputType,
      };
    default:
      return {};
  }
}

export function createOutputAttributesAsJson(output: any, outputType: string): Attributes {
  if (
    typeof output === "string" ||
    typeof output === "number" ||
    typeof output === "boolean" ||
    output === null ||
    output === undefined
  ) {
    return output;
  }

  switch (outputType) {
    case "application/json":
      return imposeAttributeLimits(flattenAttributes(output, undefined));
    case "application/super+json":
      const deserialized = deserialize(output) as any;
      const jsonify = JSON.parse(JSON.stringify(deserialized, safeReplacer));

      return imposeAttributeLimits(flattenAttributes(jsonify, undefined));
    default:
      return {};
  }
}

export function prettyPrintOutput(value: any, outputType?: string): string {
  if (value === undefined) {
    return "";
  }

  if (outputType === "application/super+json") {
    return prettyPrintOutput(deserialize(value), "application/json");
  }

  if (outputType === "application/json") {
    return JSON.stringify(value, safeReplacer, 2);
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, safeReplacer, 2);
}

function safeReplacer(key: string, value: any) {
  // If it is a BigInt
  if (typeof value === "bigint") {
    return value.toString(); // Convert to string
  }

  // if it is a Regex
  if (value instanceof RegExp) {
    return value.toString(); // Convert to string
  }

  // if it is a Set
  if (value instanceof Set) {
    return Array.from(value); // Convert to array
  }

  // if it is a Map, convert it to an object
  if (value instanceof Map) {
    const obj: Record<string, any> = {};
    value.forEach((v, k) => {
      obj[k] = v;
    });
    return obj;
  }

  return value; // Otherwise return the value as is
}
