import type { ZodType } from "zod";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";

/**
 * Parses a comma-separated `runIds` query param into a trimmed, de-duplicated
 * list of run friendly IDs, capped at 100. Shared by the runs `/live` and
 * `/children-statuses` resource routes.
 */
export const runIdsQueryParam = z
  .string()
  .optional()
  .transform((value) => {
    const ids =
      value
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean) ?? [];
    return [...new Set(ids)].slice(0, 100);
  });

/**
 * `parseInt` accepts garbage-suffixed numbers (`parseInt("123abc", 10) === 123`)
 * and returns `NaN` for non-numeric input. Use this helper at loader boundaries
 * for URL-supplied integer params so a malformed URL silently falls back to
 * `undefined` rather than nudging downstream logic with a partial or NaN value.
 */
export function parseFiniteInt(value: string | null | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function objectToSearchParams(
  obj:
    | undefined
    | Record<string, string | string[] | number | number[] | boolean | boolean[] | undefined>
): URLSearchParams | undefined {
  if (!obj) return undefined;

  const searchParams = new URLSearchParams();
  //for each item add to the search params, skip undefined and join arrays with commas
  Object.entries(obj).forEach(([key, value]) => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      for (const v of value) {
        searchParams.append(key, v.toString());
      }
    } else {
      searchParams.append(key, value.toString());
    }
  });

  return searchParams;
}

class SearchParams<TParams extends ParamType> {
  constructor(
    private params: TParams,
    readonly schema: ZodType<TParams>
  ) {}

  get(key: keyof TParams) {
    return this.params[key];
  }

  getAll() {
    return this.params;
  }

  set(key: keyof TParams, value: TParams[keyof TParams]) {
    //check it matches the schema
    const newParams = { ...this.params, [key]: value };
    const result = parseSearchParams(newParams, this.schema);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    this.params = newParams;
    return { success: true };
  }
}

type SearchParamsResult<TParams extends ParamType> =
  | { success: true; params: SearchParams<TParams> }
  | { success: false; error: string };

type ParamType = Record<string, any>;

export function createSearchParams<TParams extends ParamType>(
  url: string,
  schema: ZodType<TParams>
): SearchParamsResult<TParams> {
  const searchParams = new URL(url).searchParams;
  const params = Object.fromEntries(searchParams.entries());

  const parsed = parseSearchParams(params, schema);

  if (!parsed.success) {
    return { success: false, error: parsed.error };
  }

  return { success: true, params: new SearchParams<TParams>(parsed.params as TParams, schema) };
}

function parseSearchParams<TParams extends ParamType>(params: TParams, schema: ZodType<TParams>) {
  const parsedParams = schema.safeParse(params);

  if (!parsedParams.success) {
    const friendlyError = fromZodError(parsedParams.error, {
      prefix: "There's an issue with your search params",
    }).message;
    return { success: false as const, error: friendlyError };
  }

  return { success: true as const, params: parsedParams.data };
}
