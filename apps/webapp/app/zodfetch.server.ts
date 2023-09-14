import { z } from "zod";
import { safeJsonParse } from "./utils/json";
import { ErrorWithStackSchema } from "../../../packages/core/src";

export type ZodResponse<TResponseSchema extends z.ZodTypeAny> =
  | {
      ok: true;
      data: z.output<TResponseSchema>;
      status: number;
      headers: Headers;
    }
  | {
      ok: false;
      error: { message: string; name?: string; stack?: string };
      status: number;
      headers: Headers;
    };

const CommonErrorSchema = z.object({
  error: z.string(),
});

export async function zodfetch<TResponseSchema extends z.ZodTypeAny>(
  schema: TResponseSchema,
  url: string,
  requestInit?: RequestInit
): Promise<ZodResponse<TResponseSchema>> {
  const response = await fetch(url, requestInit);
  const contentType = response.headers.get("content-type");

  if (!response.ok) {
    // Check to see if we have a JSON body
    if (contentType?.includes("application/json")) {
      const rawJsonBody = await response.text();
      const jsonBody = safeJsonParse(rawJsonBody);

      if (!jsonBody) {
        return {
          ok: false,
          error: { message: "Failed to parse JSON response" },
          status: response.status,
          headers: response.headers,
        };
      }

      const parsed = ErrorWithStackSchema.safeParse(jsonBody);

      if (parsed.success) {
        return {
          ok: false,
          error: parsed.data,
          status: response.status,
          headers: response.headers,
        };
      }

      const commonParsed = CommonErrorSchema.safeParse(jsonBody);

      if (commonParsed.success) {
        return {
          ok: false,
          error: { message: commonParsed.data.error, name: response.statusText },
          status: response.status,
          headers: response.headers,
        };
      }

      return {
        ok: false,
        error: jsonBody as any,
        status: response.status,
        headers: response.headers,
      };
    }

    return {
      ok: false,
      error: { message: response.statusText },
      status: response.status,
      headers: response.headers,
    };
  }

  const rawJsonBody = await response.text();
  const jsonBody = safeJsonParse(rawJsonBody);

  if (!jsonBody) {
    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      data: null as any,
    };
  }

  const parsed = schema.safeParse(jsonBody);

  if (!parsed.success) {
    throw new Error(`Failed to parse response: ${parsed.error.message}`);
  }

  return {
    ok: true,
    data: parsed.data,
    status: response.status,
    headers: response.headers,
  };
}
