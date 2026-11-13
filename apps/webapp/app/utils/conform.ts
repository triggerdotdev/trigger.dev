import { parse, type Submission } from "@conform-to/react";
import { conformZodMessage, parseWithZod as conformParseWithZod } from "@conform-to/zod/v4";

export { conformZodMessage };

// Real dashboard forms stay far below these: the largest list is a bulk env var paste.
export const MAX_FORM_ENTRIES = 10_000;
export const MAX_VALUES_PER_FIELD = 1_000;
export const MAX_LIST_ITEMS = 10_000;
export const MAX_PATH_SEGMENTS = 32;

const INTENT = "__intent__";
const STATE = "__state__";
const LIMIT_MESSAGE = "This form has too many fields or list items.";

/**
 * Returns an error message when the field names of a form describe more list
 * items or values than the limits allow, before anything is built from them.
 */
export function formSizeError(payload: FormData | URLSearchParams): string | undefined {
  const valuesPerName = new Map<string, number>();
  let entries = 0;

  for (const [name] of payload) {
    if (++entries > MAX_FORM_ENTRIES) return LIMIT_MESSAGE;
    const count = (valuesPerName.get(name) ?? 0) + 1;
    const limit = name === INTENT || name === STATE ? 1 : MAX_VALUES_PER_FIELD;
    if (count > limit) return LIMIT_MESSAGE;
    valuesPerName.set(name, count);
  }
  valuesPerName.delete(INTENT);
  valuesPerName.delete(STATE);

  const paths = [...valuesPerName.keys(), ...intentPaths(payload.get(INTENT))];
  const state = parseJson(payload.get(STATE));
  if (state && typeof state === "object") paths.push(...Object.keys(state));

  const largestIndexByList = new Map<string, number>();
  for (const path of paths) {
    if (path === undefined) return LIMIT_MESSAGE;
    const segments = path.split(/[.[\]]+/, MAX_PATH_SEGMENTS + 1);
    if (segments.length > MAX_PATH_SEGMENTS) return LIMIT_MESSAGE;
    for (let i = 0; i < segments.length; i++) {
      if (!/^\d+$/.test(segments[i])) continue;
      const index = Number(segments[i]);
      if (index >= MAX_LIST_ITEMS) return LIMIT_MESSAGE;
      const list = segments.slice(0, i).join(".");
      largestIndexByList.set(list, Math.max(largestIndexByList.get(list) ?? 0, index));
    }
  }

  let listItems = 0;
  for (const index of largestIndexByList.values()) {
    listItems += index + 1;
    if (listItems > MAX_LIST_ITEMS) return LIMIT_MESSAGE;
  }

  return undefined;
}

// The paths a Conform intent writes to; `undefined` marks an index that is not a small list index.
function intentPaths(value: FormDataEntryValue | null): Array<string | undefined> {
  const intent = parseJson(value);
  if (!intent || typeof intent !== "object" || !("payload" in intent)) return [];
  const payload = intent.payload;
  if (!payload || typeof payload !== "object") return [];

  const name = "name" in payload ? payload.name : "";
  if (typeof name !== "string") return name === undefined ? [""] : [undefined];
  const index = "index" in payload ? payload.index : undefined;
  if (index === undefined || index === null) return [name];
  if (typeof index === "string") return [`${name}.${index}`];
  if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
    return [`${name}[${index}]`];
  }
  return [undefined];
}

function parseJson(value: FormDataEntryValue | null): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function limitSubmission(message: string): Submission<unknown> {
  return parse(new FormData(), { resolve: () => ({ error: { "": [message] } }) });
}

/**
 * Conform's `parseWithZod`, refusing forms that exceed the size limits above
 * with a form-level error. Import this instead of `@conform-to/zod/v4`.
 */
export const parseWithZod = ((
  payload: FormData | URLSearchParams,
  options: Parameters<typeof conformParseWithZod>[1] & { async?: boolean }
) => {
  const error = formSizeError(payload);
  if (error) {
    const submission = limitSubmission(error);
    return options.async ? Promise.resolve(submission) : submission;
  }
  return conformParseWithZod(payload, options);
}) as typeof conformParseWithZod;
