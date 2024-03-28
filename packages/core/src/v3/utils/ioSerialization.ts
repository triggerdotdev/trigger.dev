import { Attributes, Span } from "@opentelemetry/api";
import { apiClientManager } from "../apiClient";
import { OFFLOAD_IO_PACKET_LENGTH_LIMIT, imposeAttributeLimits } from "../limits";
import { SemanticInternalAttributes } from "../semanticInternalAttributes";
import { TriggerTracer } from "../tracer";
import { flattenAttributes } from "./flattenAttributes";

export type IOPacket = {
  data?: string | undefined;
  dataType: string;
};

export async function parsePacket(value: IOPacket): Promise<any> {
  if (!value.data) {
    return undefined;
  }

  switch (value.dataType) {
    case "application/json":
      return JSON.parse(value.data);
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

export async function stringifyIO(value: any): Promise<IOPacket> {
  if (value === undefined) {
    return { dataType: "application/json" };
  }

  if (typeof value === "string") {
    return { data: value, dataType: "text/plain" };
  }

  const { stringify } = await loadSuperJSON();

  return { data: stringify(value), dataType: "application/super+json" };
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

export function packetRequiresOffloading(packet: IOPacket): {
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
    needsOffloading: byteSize >= OFFLOAD_IO_PACKET_LENGTH_LIMIT,
    size: byteSize,
  };
}

async function exportPacket(packet: IOPacket, pathPrefix: string): Promise<IOPacket> {
  // Offload the output
  const filename = `${pathPrefix}.${getPacketExtension(packet.dataType)}`;

  const presignedResponse = await apiClientManager.client!.createUploadPayloadUrl(filename);

  if (presignedResponse.ok) {
    const uploadResponse = await fetch(presignedResponse.data.presignedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": packet.dataType,
      },
      body: packet.data,
    });

    if (!uploadResponse.ok) {
      throw new Error(
        `Failed to upload output to ${presignedResponse.data.presignedUrl}: ${uploadResponse.statusText}`
      );
    }

    return {
      data: filename,
      dataType: "application/store",
    };
  }

  return packet;
}

export async function conditionallyImportPacket(
  packet: IOPacket,
  tracer?: TriggerTracer
): Promise<IOPacket> {
  if (packet.dataType !== "application/store") {
    return packet;
  }

  if (!tracer) {
    return await importPacket(packet);
  } else {
    const result = await tracer.startActiveSpan(
      "store.downloadPayload",
      async (span) => {
        return await importPacket(packet, span);
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

async function importPacket(packet: IOPacket, span?: Span): Promise<IOPacket> {
  if (!packet.data) {
    return packet;
  }

  if (!apiClientManager.client) {
    return packet;
  }

  const presignedResponse = await apiClientManager.client.getPayloadUrl(packet.data);

  if (presignedResponse.ok) {
    const response = await fetch(presignedResponse.data.presignedUrl);

    if (!response.ok) {
      throw new Error(
        `Failed to import packet ${presignedResponse.data.presignedUrl}: ${response.statusText}`
      );
    }

    const data = await response.text();

    span?.setAttribute("size", Buffer.byteLength(data, "utf8"));

    return {
      data,
      dataType: response.headers.get("content-type") ?? "application/json",
    };
  }

  return packet;
}

export async function createPacketAttributes(
  packet: IOPacket,
  dataKey: string,
  dataTypeKey: string
): Promise<Attributes> {
  if (!packet.data) {
    return {};
  }

  switch (packet.dataType) {
    case "application/json":
      return {
        ...flattenAttributes(packet, dataKey),
        [dataTypeKey]: packet.dataType,
      };
    case "application/super+json":
      const { parse } = await loadSuperJSON();

      const parsed = parse(packet.data) as any;
      const jsonified = JSON.parse(JSON.stringify(parsed, safeReplacer));

      return {
        ...flattenAttributes(jsonified, dataKey),
        [dataTypeKey]: "application/json",
      };
    case "application/store":
      return {
        [dataKey]: packet.data,
        [dataTypeKey]: packet.dataType,
      };
    case "text/plain":
      return {
        [SemanticInternalAttributes.OUTPUT]: packet.data,
        [SemanticInternalAttributes.OUTPUT_TYPE]: packet.dataType,
      };
    default:
      return {};
  }
}

export async function createPackageAttributesAsJson(
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
    case "application/json":
      return imposeAttributeLimits(flattenAttributes(data, undefined));
    case "application/super+json":
      const { deserialize } = await loadSuperJSON();

      const deserialized = deserialize(data) as any;
      const jsonify = JSON.parse(JSON.stringify(deserialized, safeReplacer));

      return imposeAttributeLimits(flattenAttributes(jsonify, undefined));
    case "application/store":
      return data;
    default:
      return {};
  }
}

export async function prettyPrintPacket(rawData: any, dataType?: string): Promise<string> {
  if (rawData === undefined) {
    return "";
  }

  if (dataType === "application/super+json") {
    const { deserialize } = await loadSuperJSON();

    return await prettyPrintPacket(deserialize(rawData), "application/json");
  }

  if (dataType === "application/json") {
    return JSON.stringify(rawData, safeReplacer, 2);
  }

  if (typeof rawData === "string") {
    return rawData;
  }

  return JSON.stringify(rawData, safeReplacer, 2);
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

async function loadSuperJSON(): Promise<typeof import("superjson")> {
  return await import("superjson");
}
