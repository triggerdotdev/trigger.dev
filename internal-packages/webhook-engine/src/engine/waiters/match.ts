import { createHash } from "node:crypto";
import { resolveKeyPath, walkPath, type SessionKeyNamespaces } from "../sessionKey.js";

export type WaiterMatchValue = string | number | boolean;

/** The match shape of URL-matched waiters: never read by endpoint deliveries, only by their own URL. */
export const URL_SHAPE = "__url__";
const URL_VALUES = "url";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const WEBHOOK_FIELDS = new Set(["externalRef", "tenantId", "id", "source", "deliveryId"]);

export type WaiterShape = { paths: string[]; shape: string; values: string };

/**
 * A waiter's match shape and key. The sorted set of paths is the shape; the values at those paths
 * are the key. A waiter without `match` is URL-matched and shares one key per endpoint.
 */
export function waiterShape(match: Record<string, WaiterMatchValue> | undefined): WaiterShape {
  if (!match || Object.keys(match).length === 0) {
    return { paths: [], shape: URL_SHAPE, values: URL_VALUES };
  }
  const paths = Object.keys(match).sort();
  return {
    paths,
    shape: shapeHash(paths),
    values: valuesHash(
      paths,
      paths.map((path) => String(match[path]))
    ),
  };
}

function shapeHash(paths: string[]): string {
  return createHash("sha256").update(JSON.stringify(paths)).digest("hex").slice(0, 16);
}

export function valuesHash(paths: string[], values: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(paths.map((path, i) => [path, values[i]])))
    .digest("hex")
    .slice(0, 16);
}

/** Why a match is invalid, or undefined when it is valid. */
export function validateMatch(
  match: Record<string, unknown> | undefined,
  maxPaths: number
): string | undefined {
  if (!match) return undefined;
  const entries = Object.entries(match);
  if (entries.length > maxPaths)
    return `match has ${entries.length} paths; the limit is ${maxPaths}`;
  for (const [path, value] of entries) {
    const segments = path.split(".");
    if (path === "" || segments.some((s) => s === "" || FORBIDDEN_SEGMENTS.has(s))) {
      return `match path "${path}" is not a valid dotted path`;
    }
    const [namespace, ...rest] = segments;
    if (namespace !== "event" && namespace !== "header" && namespace !== "webhook") {
      const suggestion = namespace === "body" ? rest.join(".") : path;
      return `match path "${path}" needs a namespace: use event.${suggestion} for the event body, header.<name> or webhook.<field>`;
    }
    if (rest.length === 0) {
      return `match path "${path}" needs a field after the namespace, like ${namespace}.id`;
    }
    if (namespace === "webhook" && (rest.length !== 1 || !WEBHOOK_FIELDS.has(rest[0]!))) {
      return `match path "${path}" is not an endpoint field; use one of ${[...WEBHOOK_FIELDS].map((f) => `webhook.${f}`).join(", ")}`;
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      return `match value at "${path}" must be a string, number or boolean`;
    }
  }
  return undefined;
}

/**
 * The values a delivery has at a shape's paths (`event.*` in the body, `header.*`, `webhook.*`), as
 * strings, or undefined when any path is missing or not a scalar (the delivery can't match that shape).
 */
export function eventValues(paths: string[], ns: SessionKeyNamespaces): string[] | undefined {
  const values: string[] = [];
  for (const path of paths) {
    const value = path.startsWith("event.")
      ? walkPath(ns.body, path.slice("event.".length))
      : resolveKeyPath(path, ns);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return undefined;
    }
    values.push(String(value));
  }
  return values;
}
