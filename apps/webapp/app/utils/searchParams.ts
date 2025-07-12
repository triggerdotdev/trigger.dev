import { ZodType } from "zod";
import { fromZodError } from "zod-validation-error";

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
  constructor(private params: TParams, readonly schema: ZodType<TParams>) {}

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
