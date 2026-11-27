import { z } from "zod";
import { fenceUntrusted } from "./gate/fence.server";

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_NAMED = 10;
const AFFIX_CHARS = 5;

/**
 * The tool's input schema with unknown top-level fields rejected before any other check.
 * A preprocess step keeps the JSON Schema in tools/list unchanged.
 */
export function toolArgumentsSchema(shape: z.ZodRawShape) {
  // Some clients add a placeholder argument to tools that declare none.
  if (Object.keys(shape).length === 0) return z.object(shape);
  return z.preprocess((args, ctx) => {
    if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
    const message = unknownFieldsMessage(args as Record<string, unknown>, shape);
    if (message) ctx.addIssue({ code: "custom", message });
    return args;
  }, z.object(shape));
}

function unknownFieldsMessage(args: Record<string, unknown>, shape: z.ZodRawShape) {
  const known = Object.keys(shape);
  const unknown = Object.keys(args).filter((key) => !Object.hasOwn(shape, key));
  if (unknown.length === 0) return undefined;

  const named = unknown.slice(0, MAX_NAMED);
  const close = named.map((name) => closestField(name, known));
  const missing =
    unknown.length > MAX_NAMED
      ? []
      : known.filter(
          (key) => args[key] === undefined && !close.includes(key) && isRequired(shape[key]!)
        );
  // A lone unmatched field most likely stands in for the lone missing required one.
  const paired =
    close.filter((s) => s === undefined).length === 1 && missing.length === 1
      ? missing[0]
      : undefined;

  const parts = named.map((name, i) => {
    const suggestion = close[i] ?? paired;
    return suggestion
      ? `Unknown field ${quoteName(name)}; did you mean ${suggestion}?`
      : `Unknown field ${quoteName(name)}.`;
  });
  if (unknown.length > MAX_NAMED) parts.push(`And ${unknown.length - MAX_NAMED} more.`);
  // A paired suggestion is a guess, so the known fields are listed with it.
  if (close.includes(undefined)) parts.push(`Known fields: ${known.join(", ")}.`);
  return parts.join(" ");
}

// The object's own rule for a required key; z.any() accepts undefined alone but is still required.
const isRequired = (field: z.ZodRawShape[string]) => field._zod.optin === undefined;

const quoteName = (name: string) =>
  PLAIN_NAME.test(name)
    ? name
    : fenceUntrusted(name.length > 64 ? `${name.slice(0, 64)}…` : name, "argument-name");

// Close: edit distance (a swap counts as one) at most a third of the name, or a shared 5-letter prefix or suffix.
function closestField(name: string, known: string[]) {
  if (name.length > 64) return undefined;
  const lower = name.toLowerCase();
  const maxDistance = Math.max(1, Math.floor(lower.length / 3));
  return known
    .map((field) => ({ field, other: field.toLowerCase() }))
    .map(({ field, other }) => ({
      field,
      distance: editDistance(lower, other),
      affix: sharedAffix(lower, other),
    }))
    .filter(({ distance, affix }) => distance <= maxDistance || affix >= AFFIX_CHARS)
    .reduce<{ field: string; distance: number } | undefined>(
      (best, c) => (!best || c.distance < best.distance ? c : best),
      undefined
    )?.field;
}

function sharedAffix(a: string, b: string) {
  let prefix = 0;
  while (prefix < a.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length && suffix < b.length && a.at(-1 - suffix) === b.at(-1 - suffix)) {
    suffix++;
  }
  return Math.max(prefix, suffix);
}

function editDistance(a: string, b: string) {
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j]!, beforePrevious[j - 2]! + 1);
      }
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length]!;
}
