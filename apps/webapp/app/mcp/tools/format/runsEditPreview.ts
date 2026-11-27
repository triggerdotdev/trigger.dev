import type { RunMetadataChangeOperation } from "@trigger.dev/core/v3/schemas";
import { canonicalJson, PREVIEW_LIMIT } from "../../confirm/confirmation.server";

const TEXT_CHARS = 128;
const KEY_CHARS = 1_024;
const HEADER_ALLOWANCE = 1_024;
const REMOVED_LIST_CHARS = 8_192;
const REMOVED_LABEL = "This removes the run's current keys: ";
const METADATA_ALLOWANCE = HEADER_ALLOWANCE + REMOVED_LABEL.length + REMOVED_LIST_CHARS + 1;
const INVISIBLE_LAYOUT = /[\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

export const PREVIEW_TOO_LARGE =
  "This change is too large to show in full for approval. Split it into smaller calls.";
const KEY_TOO_LONG = `A metadata key is longer than ${KEY_CHARS.toLocaleString("en-US")} characters, so it cannot be shown in full for approval. Shorten the key.`;

export function escapeText(text: string): string {
  return JSON.stringify(text).replace(
    INVISIBLE_LAYOUT,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

export const escapeLayout = (text: string) =>
  text.replace(INVISIBLE_LAYOUT, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export const formatValue = (value: unknown) => escapeLayout(canonicalJson(value) ?? "undefined");

export function quote(text: string): string {
  return escapeText(text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)}…` : text);
}

const isPath = (key: string) => key.startsWith("$.");
const hasWildcard = (key: string) => key.split(".").includes("*");

function replaceAll(metadata: Record<string, unknown>) {
  const entries = Object.entries(metadata);
  return entries.length === 0
    ? "replace ALL metadata with an empty object: all metadata is removed"
    : `replace ALL metadata with: ${entries.map(([key, value]) => `${escapeText(key)} = ${formatValue(value)}`).join(", ")}; every existing key not listed is removed`;
}

function describeOperation(op: RunMetadataChangeOperation): string {
  switch (op.type) {
    case "set": {
      const key = escapeText(op.key);
      const value = formatValue(op.value);
      if (!isPath(op.key)) return `set ${key} to ${value} (replaces any current value)`;
      return hasWildcard(op.key)
        ? `set path ${key} to ${value} at EVERY location this wildcard path matches (replaces any value there and everything under it)`
        : `set path ${key} to ${value} (replaces any value at this path and everything under it)`;
    }
    case "delete": {
      const key = escapeText(op.key);
      return isPath(op.key)
        ? `delete the top-level key named exactly ${key} (the path is not followed)`
        : `delete ${key}`;
    }
    case "append":
      return `append ${formatValue(op.value)} to ${escapeText(op.key)}: a missing value becomes a one-item list, a value that is not a list becomes a list`;
    case "remove":
      return `remove every value equal to ${formatValue(op.value)} from the list at ${escapeText(op.key)} (no change if it is not a list)`;
    case "increment":
      return `increment ${escapeText(op.key)} by ${op.value}: a missing or non-number value is replaced with ${op.value}`;
    case "update":
      return replaceAll(op.value);
  }
}

const keysOf = (op: RunMetadataChangeOperation) =>
  op.type === "update" ? Object.keys(op.value) : [op.key];

export function describeOperations(operations: RunMetadataChangeOperation[]): string[] {
  return operations.map((op, i) => `${i + 1}. ${describeOperation(op)}`);
}

export function describeReplacement(metadata: Record<string, unknown>): string[] {
  return [`1. ${replaceAll(metadata)}`];
}

function previewIssue(
  keys: string[],
  lines: () => string[],
  allowance = HEADER_ALLOWANCE
): string | undefined {
  if (keys.some((key) => key.length > KEY_CHARS)) return KEY_TOO_LONG;
  return lines().join("\n").length > PREVIEW_LIMIT - allowance ? PREVIEW_TOO_LARGE : undefined;
}

export const operationsPreviewIssue = (operations: RunMetadataChangeOperation[]) =>
  previewIssue(
    operations.flatMap(keysOf),
    () => describeOperations(operations),
    METADATA_ALLOWANCE
  );

export const replacementPreviewIssue = (metadata: Record<string, unknown>) =>
  previewIssue(Object.keys(metadata), () => describeReplacement(metadata), METADATA_ALLOWANCE);

export const tagsPreviewIssue = (tags: string[]) =>
  previewIssue([], () => [tags.map(escapeText).join(", ")]);

export function describeRemovedKeys(
  current: Record<string, unknown>,
  result: Record<string, unknown>
): string {
  const removed = Object.keys(current).filter((key) => !Object.hasOwn(result, key));
  if (removed.length === 0) return "None of the run's current keys are removed.";
  const listed = removed.map(escapeText).join(", ");
  return listed.length <= REMOVED_LIST_CHARS
    ? `${REMOVED_LABEL}${listed}`
    : `This removes ${removed.length} of the run's current keys.`;
}
