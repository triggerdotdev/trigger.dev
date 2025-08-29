import { Attributes, Span } from "@opentelemetry/api";
import { z } from "zod";
import { ApiClient } from "../apiClient/index.js";
import { apiClientManager } from "../apiClientManager-api.js";
import {
  OFFLOAD_IO_PACKET_LENGTH_LIMIT,
  OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT,
  imposeAttributeLimits,
} from "../limits.js";
import type { RetryOptions } from "../schemas/index.js";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
import { TriggerTracer } from "../tracer.js";
import { zodfetch } from "../zodfetch.js";
import { flattenAttributes } from "./flattenAttributes.js";
import { JSONHeroPath } from "@jsonhero/path";

export type IOPacket = {
  data?: string | undefined;
  dataType: string;
};

export type ParsePacketOptions = {
  filteredKeys?: string[];
};

export async function parsePacket(value: IOPacket, options?: ParsePacketOptions): Promise<any> {
  if (!value.data) {
    return undefined;
  }

  switch (value.dataType) {
    case "application/json":
      return JSON.parse(value.data, makeSafeReviver(options));
    case "application/super+json":
      const { parse } = await loadSuperJSON();

      return parse(value.data);
    case "text/plain":
      return value.data;
    case "application/store":
      throw new Error(
        `Cannot parse an application/store packet (${value.data}). Needs to be imported first.`
      );
    default:
      return value.data;
  }
}

export async function parsePacketAsJson(
  value: IOPacket,
  options?: ParsePacketOptions
): Promise<any> {
  if (!value.data) {
    return undefined;
  }

  switch (value.dataType) {
    case "application/json":
      return JSON.parse(value.data, makeSafeReviver(options));
    case "application/super+json":
      const { parse, serialize } = await loadSuperJSON();

      const superJsonResult = parse(value.data);

      const { json } = serialize(superJsonResult);

      return json;
    case "text/plain":
      return value.data;
    case "application/store":
      throw new Error(
        `Cannot parse an application/store packet (${value.data}). Needs to be imported first.`
      );
    default:
      return value.data;
  }
}

export async function conditionallyImportAndParsePacket(
  value: IOPacket,
  client?: ApiClient
): Promise<any> {
  const importedPacket = await conditionallyImportPacket(value, undefined, client);

  return await parsePacket(importedPacket);
}

export async function stringifyIO(value: any): Promise<IOPacket> {
  if (value === undefined) {
    return { dataType: "application/json" };
  }

  if (typeof value === "string") {
    return { data: value, dataType: "text/plain" };
  }

  try {
    const { stringify } = await loadSuperJSON();
    const data = stringify(value);

    return { data, dataType: "application/super+json" };
  } catch {
    return { data: value, dataType: "application/json" };
  }
}

export async function conditionallyExportPacket(
  packet: IOPacket,
  pathPrefix: string,
  tracer?: TriggerTracer
): Promise<IOPacket> {
  if (apiClientManager.client) {
    const { needsOffloading, size } = packetRequiresOffloading(packet);

    if (needsOffloading) {
      if (!tracer) {
        return await exportPacket(packet, pathPrefix);
      } else {
        const result = await tracer.startActiveSpan(
          "store.uploadOutput",
          async (span) => {
            return await exportPacket(packet, pathPrefix);
          },
          {
            attributes: {
              byteLength: size,
              [SemanticInternalAttributes.STYLE_ICON]: "cloud-upload",
            },
          }
        );

        return result ?? packet;
      }
    }
  }

  return packet;
}

export function packetRequiresOffloading(
  packet: IOPacket,
  lengthLimit?: number
): {
  needsOffloading: boolean;
  size: number;
} {
  if (!packet.data) {
    return {
      needsOffloading: false,
      size: 0,
    };
  }

  const byteSize = Buffer.byteLength(packet.data, "utf8");

  return {
    needsOffloading: byteSize >= (lengthLimit ?? OFFLOAD_IO_PACKET_LENGTH_LIMIT),
    size: byteSize,
  };
}

const ioRetryOptions = {
  minTimeoutInMs: 500,
  maxTimeoutInMs: 5000,
  maxAttempts: 5,
  factor: 2,
  randomize: true,
} satisfies RetryOptions;

async function exportPacket(packet: IOPacket, pathPrefix: string): Promise<IOPacket> {
  // Offload the output
  const filename = `${pathPrefix}.${getPacketExtension(packet.dataType)}`;

  const presignedResponse = await apiClientManager.client!.createUploadPayloadUrl(filename);

  const uploadResponse = await zodfetch(
    z.any(),
    presignedResponse.presignedUrl,
    {
      method: "PUT",
      headers: {
        "Content-Type": packet.dataType,
      },
      body: packet.data,
    },
    {
      retry: ioRetryOptions,
    }
  ).asResponse();

  if (!uploadResponse.ok) {
    throw new Error(
      `Failed to upload output to ${presignedResponse.presignedUrl}: ${uploadResponse.statusText}`
    );
  }

  return {
    data: filename,
    dataType: "application/store",
  };
}

export async function conditionallyImportPacket(
  packet: IOPacket,
  tracer?: TriggerTracer,
  client?: ApiClient
): Promise<IOPacket> {
  if (packet.dataType !== "application/store") {
    return packet;
  }

  if (!tracer) {
    return await importPacket(packet, undefined, client);
  } else {
    const result = await tracer.startActiveSpan(
      "store.downloadPayload",
      async (span) => {
        return await importPacket(packet, span, client);
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "cloud-download",
        },
      }
    );

    return result ?? packet;
  }
}

export async function resolvePresignedPacketUrl(
  url: string,
  tracer?: TriggerTracer
): Promise<any | undefined> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return;
    }

    const data = await response.text();
    const dataType = response.headers.get("content-type") ?? "application/json";

    const packet = {
      data,
      dataType,
    };

    return await parsePacket(packet);
  } catch (error) {
    return;
  }
}

async function importPacket(packet: IOPacket, span?: Span, client?: ApiClient): Promise<IOPacket> {
  if (!packet.data) {
    return packet;
  }

  const $client = client ?? apiClientManager.client;

  if (!$client) {
    return packet;
  }

  const presignedResponse = await $client.getPayloadUrl(packet.data);

  const response = await zodfetch(z.any(), presignedResponse.presignedUrl, undefined, {
    retry: ioRetryOptions,
  }).asResponse();

  if (!response.ok) {
    throw new Error(
      `Failed to import packet ${presignedResponse.presignedUrl}: ${response.statusText}`
    );
  }

  const data = await response.text();

  span?.setAttribute("size", Buffer.byteLength(data, "utf8"));

  return {
    data,
    dataType: response.headers.get("content-type") ?? "application/json",
  };
}

export async function createPacketAttributes(
  packet: IOPacket,
  dataKey: string,
  dataTypeKey: string
): Promise<Attributes | undefined> {
  if (!packet.data) {
    return;
  }

  switch (packet.dataType) {
    case "application/json":
      return {
        ...flattenAttributes(packet, dataKey),
        [dataTypeKey]: packet.dataType,
      };
    case "application/super+json":
      const { parse } = await loadSuperJSON();

      if (typeof packet.data === "undefined" || packet.data === null) {
        return;
      }

      try {
        const parsed = parse(packet.data) as any;
        const jsonified = JSON.parse(JSON.stringify(parsed, makeSafeReplacer()));

        const result = {
          ...flattenAttributes(jsonified, dataKey),
          [dataTypeKey]: "application/json",
        };

        return result;
      } catch (e) {
        return;
      }

    case "application/store":
      return {
        [dataKey]: packet.data,
        [dataTypeKey]: packet.dataType,
      };
    case "text/plain":
      return {
        [dataKey]: packet.data,
        [dataTypeKey]: packet.dataType,
      };
    default:
      return;
  }
}

export async function createPacketAttributesAsJson(
  data: any,
  dataType: string
): Promise<Attributes> {
  if (
    typeof data === "string" ||
    typeof data === "number" ||
    typeof data === "boolean" ||
    data === null ||
    data === undefined
  ) {
    return data;
  }

  switch (dataType) {
    case "application/json": {
      return imposeAttributeLimits(
        flattenAttributes(data, undefined, OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT)
      );
    }
    case "application/super+json": {
      const { deserialize } = await loadSuperJSON();

      const deserialized = deserialize(data) as any;
      const jsonify = safeJsonParse(JSON.stringify(deserialized, makeSafeReplacer()));

      return imposeAttributeLimits(
        flattenAttributes(jsonify, undefined, OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT)
      );
    }
    case "application/store": {
      return data;
    }
    default: {
      return {};
    }
  }
}

export async function prettyPrintPacket(
  rawData: any,
  dataType?: string,
  options?: ReplacerOptions
): Promise<string> {
  if (rawData === undefined) {
    return "";
  }

  if (dataType === "application/super+json") {
    if (typeof rawData === "string") {
      rawData = safeJsonParse(rawData);
    }
    const { deserialize } = await loadSuperJSON();

    return await prettyPrintPacket(deserialize(rawData), "application/json");
  }

  if (dataType === "application/json") {
    if (typeof rawData === "string") {
      rawData = safeJsonParse(rawData);
    }
    return JSON.stringify(rawData, makeSafeReplacer(options), 2);
  }

  if (typeof rawData === "string") {
    return rawData;
  }

  return JSON.stringify(rawData, makeSafeReplacer(options), 2);
}

interface ReplacerOptions {
  filteredKeys?: string[];
}

function makeSafeReplacer(options?: ReplacerOptions) {
  const seen = new WeakSet<any>();

  return function replacer(key: string, value: any) {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    // Check if the key should be filtered out
    if (options?.filteredKeys?.includes(key)) {
      return undefined;
    }

    // If it is a BigInt
    if (typeof value === "bigint") {
      return value.toString();
    }

    // if it is a Regex
    if (value instanceof RegExp) {
      return value.toString();
    }

    // if it is a Set
    if (value instanceof Set) {
      return Array.from(value);
    }

    // if it is a Map, convert it to an object
    if (value instanceof Map) {
      const obj: Record<string, any> = {};
      value.forEach((v, k) => {
        obj[k] = v;
      });
      return obj;
    }

    return value;
  };
}

function makeSafeReviver(options?: ReplacerOptions) {
  if (!options) {
    return undefined;
  }

  return function reviver(key: string, value: any) {
    // Check if the key should be filtered out
    if (options?.filteredKeys?.includes(key)) {
      return undefined;
    }

    return value;
  };
}

function getPacketExtension(outputType: string): string {
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

async function loadSuperJSON() {
  const superjson = await import("superjson");

  superjson.registerCustom<Buffer, number[]>(
    {
      isApplicable: (v): v is Buffer => typeof Buffer === "function" && Buffer.isBuffer(v),
      serialize: (v) => [...v],
      deserialize: (v) => Buffer.from(v),
    },
    "buffer"
  );

  return superjson;
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return;
  }
}

/**
 * Replaces the data in a SuperJSON-serialized string with new payload data while preserving
 * the original type metadata (Dates, BigInts, Sets, Maps, etc.).
 *
 * It is primarily useful for our run replay functionality where we want to preserve the original
 * type metadata for the new payload.
 *
 * Note that `undefined` type metadata is ignored when the corresponding field is overriden in the
 * new payload, i.e., fields which were previously undefined in the original payload are restored into
 * the primitive type they have in the new payload, instead of `undefined`.
 * This is a workaround for https://github.com/triggerdotdev/trigger.dev/issues/1968.
 *
 * @param original - A SuperJSON-serialized string containing the original data with type metadata
 * @param newPayload - A JSON string containing the new data to replace the original payload
 * @returns The deserialized object with new data but original type metadata preserved
 *
 * @throws {Error} If the newPayload is not valid JSON
 */
export async function replaceSuperJsonPayload(original: string, newPayload: string) {
  const superjson = await loadSuperJSON();
  const originalObject = superjson.parse(original);
  const newPayloadObject = JSON.parse(newPayload);
  const { meta } = superjson.serialize(originalObject);

  if (meta?.values) {
    const originalUndefinedKeys = Object.entries(meta.values)
      .filter(([, value]) => Array.isArray(value) && value.at(0) === "undefined")
      .map(([key]) => key);

    const overridenUndefinedKeys = originalUndefinedKeys.filter(
      (key) => getKeyFromObject(newPayloadObject, key) !== undefined
    );

    overridenUndefinedKeys.forEach((key) => {
      delete (meta.values as Record<string, any>)[key];
    });
  }

  const newSuperJson = {
    json: newPayloadObject,
    meta,
  };

  return superjson.deserialize(newSuperJson);
}

function getKeyFromObject(object: unknown, key: string) {
  const jsonHeroPath = new JSONHeroPath(key);

  return jsonHeroPath.first(object);
}
