import { z } from "zod";
import { context, propagation } from "@opentelemetry/api";

type ApiResult<TSuccessResult> =
  | { ok: true; data: TSuccessResult }
  | {
      ok: false;
      error: string;
    };

export async function zodfetch<TResponseBody extends any>(
  schema: z.Schema<TResponseBody>,
  url: string,
  requestInit?: RequestInit
): Promise<ApiResult<TResponseBody>> {
  try {
    const response = await fetch(url, requestInit);

    if ((!requestInit || requestInit.method === "GET") && response.status === 404) {
      return {
        ok: false,
        error: `404: ${response.statusText}`,
      };
    }

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();
      if (!body.error) {
        return { ok: false, error: "Something went wrong" };
      }

      return { ok: false, error: body.error };
    }

    if (response.status !== 200) {
      return {
        ok: false,
        error: `Failed to fetch ${url}, got status code ${response.status}`,
      };
    }

    const jsonBody = await response.json();
    const parsedResult = schema.safeParse(jsonBody);

    if (parsedResult.success) {
      return { ok: true, data: parsedResult.data };
    }

    if ("error" in jsonBody) {
      return {
        ok: false,
        error: typeof jsonBody.error === "string" ? jsonBody.error : JSON.stringify(jsonBody.error),
      };
    }

    return { ok: false, error: parsedResult.error.message };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : JSON.stringify(error),
    };
  }
}
