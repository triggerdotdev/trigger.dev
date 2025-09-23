import { Attributes } from "@opentelemetry/api";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";
import { parseTraceparent } from "@trigger.dev/core/v3/isomorphic";
import { ExceptionEventProperties, SpanEvents, TaskRunError } from "@trigger.dev/core/v3/schemas";
import { unflattenAttributes } from "@trigger.dev/core/v3/utils/flattenAttributes";
import { createHash } from "node:crypto";

export function extractContextFromCarrier(carrier: Record<string, unknown>) {
  const traceparent = carrier["traceparent"];
  const tracestate = carrier["tracestate"];

  if (typeof traceparent !== "string") {
    return undefined;
  }

  return {
    ...carrier,
    traceparent: parseTraceparent(traceparent),
    tracestate,
  };
}

export function getNowInNanoseconds(): bigint {
  return BigInt(new Date().getTime() * 1_000_000);
}

export function getDateFromNanoseconds(nanoseconds: bigint): Date {
  return new Date(Number(nanoseconds) / 1_000_000);
}

export function calculateDurationFromStart(startTime: bigint, endTime: Date = new Date()) {
  const $endtime = typeof endTime === "string" ? new Date(endTime) : endTime;

  return Number(BigInt($endtime.getTime() * 1_000_000) - startTime);
}

export function convertDateToNanoseconds(date: Date): bigint {
  return BigInt(date.getTime()) * BigInt(1_000_000);
}

/**
 * Returns a deterministically random 8-byte span ID formatted/encoded as a 16 lowercase hex
 * characters corresponding to 64 bits, based on the trace ID and seed.
 */
export function generateDeterministicSpanId(traceId: string, seed: string) {
  const hash = createHash("sha1");
  hash.update(traceId);
  hash.update(seed);
  const buffer = hash.digest();
  let hexString = "";
  for (let i = 0; i < 8; i++) {
    const val = buffer.readUInt8(i);
    const str = val.toString(16).padStart(2, "0");
    hexString += str;
  }
  return hexString;
}

const randomIdGenerator = new RandomIdGenerator();

export function generateTraceId() {
  return randomIdGenerator.generateTraceId();
}

export function generateSpanId() {
  return randomIdGenerator.generateSpanId();
}

export function stripAttributePrefix(attributes: Attributes, prefix: string) {
  const result: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length + 1)] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function parseEventsField(events: unknown): SpanEvents {
  if (!events) return [];
  if (!Array.isArray(events)) return [];

  const unsafe = events
    ? (events as any[]).map((e) => ({
        ...e,
        properties: unflattenAttributes(e.properties as Attributes),
      }))
    : undefined;

  return unsafe as SpanEvents;
}

export function createExceptionPropertiesFromError(error: TaskRunError): ExceptionEventProperties {
  switch (error.type) {
    case "BUILT_IN_ERROR": {
      return {
        type: error.name,
        message: error.message,
        stacktrace: error.stackTrace,
      };
    }
    case "CUSTOM_ERROR": {
      return {
        type: "Error",
        message: error.raw,
      };
    }
    case "INTERNAL_ERROR": {
      return {
        type: "Internal error",
        message: [error.code, error.message].filter(Boolean).join(": "),
        stacktrace: error.stackTrace,
      };
    }
    case "STRING_ERROR": {
      return {
        type: "Error",
        message: error.raw,
      };
    }
  }
}
