import { AttributeValue, Attributes } from "@opentelemetry/api";
import { getEnvVar } from "./utils/getEnv.js";

function getOtelEnvVarLimit(key: string, defaultValue: number) {
  const value = getEnvVar(key);

  if (!value) {
    return defaultValue;
  }

  return parseInt(value, 10);
}

export const OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT = getOtelEnvVarLimit(
  "TRIGGER_OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
  256
);
export const OTEL_LOG_ATTRIBUTE_COUNT_LIMIT = getOtelEnvVarLimit(
  "TRIGGER_OTEL_LOG_ATTRIBUTE_COUNT_LIMIT",
  256
);
export const OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT = getOtelEnvVarLimit(
  "TRIGGER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  131072
);
export const OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT = getOtelEnvVarLimit(
  "TRIGGER_OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  131072
);
export const OTEL_SPAN_EVENT_COUNT_LIMIT = getOtelEnvVarLimit(
  "TRIGGER_OTEL_SPAN_EVENT_COUNT_LIMIT",
  10
);
export const OTEL_LINK_COUNT_LIMIT = getOtelEnvVarLimit("TRIGGER_OTEL_LINK_COUNT_LIMIT", 2);
export const OTEL_ATTRIBUTE_PER_LINK_COUNT_LIMIT = getOtelEnvVarLimit(
  "TRIGGER_OTEL_ATTRIBUTE_PER_LINK_COUNT_LIMIT",
  10
);
export const OTEL_ATTRIBUTE_PER_EVENT_COUNT_LIMIT = getOtelEnvVarLimit(
  "TRIGGER_OTEL_ATTRIBUTE_PER_EVENT_COUNT_LIMIT",
  10
);

export const OFFLOAD_IO_PACKET_LENGTH_LIMIT = 128 * 1024;

export function imposeAttributeLimits(attributes: Attributes): Attributes {
  const newAttributes: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (calculateAttributeValueLength(value) > OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT) {
      continue;
    }

    if (Object.keys(newAttributes).length >= OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT) {
      break;
    }

    newAttributes[key] = value;
  }

  return newAttributes;
}

function calculateAttributeValueLength(value: AttributeValue | undefined | null): number {
  if (value === undefined || value === null) {
    return 0;
  }

  if (typeof value === "string") {
    return value.length;
  }

  if (typeof value === "number") {
    return 8;
  }

  if (typeof value === "boolean") {
    return 4;
  }

  if (Array.isArray(value)) {
    return value.reduce((acc: number, v) => acc + calculateAttributeValueLength(v), 0);
  }

  return 0;
}
