import { Attributes } from "@opentelemetry/api";
import { deserialize, parse, stringify } from "superjson";
import { SemanticInternalAttributes } from "../semanticInternalAttributes";
import { flattenAttributes } from "./flattenAttributes";
import { OFFLOAD_OUTPUT_LENGTH_LIMIT, imposeAttributeLimits } from "../limits";
import { apiClientManager } from "../apiClient";
import { TriggerTracer } from "../tracer";

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

export async function offloadOuputIfNeeded(
  output: OutputParseable,
  pathPrefix: string,
  tracer: TriggerTracer
): Promise<OutputParseable> {
  if (apiClientManager.client && output.output) {
    const byteSize = Buffer.byteLength(output.output, "utf8");

    if (byteSize >= OFFLOAD_OUTPUT_LENGTH_LIMIT) {
      const result = await tracer.startActiveSpan(
        "io.uploadOutput",
        async (span) => {
          // Offload the output
          const filename = `${pathPrefix}/output.${getOutputExtension(output.outputType)}`;

          const presignedResponse = await apiClientManager.client!.createUploadPayloadUrl(filename);

          if (presignedResponse.ok) {
            const uploadResponse = await fetch(presignedResponse.data.presignedUrl, {
              method: "PUT",
              headers: {
                "Content-Type": output.outputType,
              },
              body: output.output,
            });

            if (!uploadResponse.ok) {
              throw new Error(
                `Failed to upload output to ${presignedResponse.data.presignedUrl}: ${uploadResponse.statusText}`
              );
            }

            return {
              output: filename,
              outputType: "application/store",
            };
          }
        },
        {
          attributes: {
            size: byteSize,
            [SemanticInternalAttributes.STYLE_ICON]: "cloud-upload",
          },
        }
      );

      return result ?? output;
    }
  }

  return output;
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
    case "application/store":
      return {
        [SemanticInternalAttributes.OUTPUT]: output.output,
        [SemanticInternalAttributes.OUTPUT_TYPE]: output.outputType,
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
    case "application/store":
      return output;
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

function getOutputExtension(outputType: string): string {
  switch (outputType) {
    case "application/json":
      return "json";
    case "application/super+json":
      return "json";
    case "text/plain":
      return "txt";
    default:
      return "txt";
  }
}
