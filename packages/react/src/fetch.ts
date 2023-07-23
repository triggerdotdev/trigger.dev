import { z } from "zod";

export async function zodfetch<
  TResponseBody extends any,
  TOptional extends boolean = false
>(
  schema: z.Schema<TResponseBody>,
  url: string,
  requestInit?: RequestInit,
  options?: {
    errorMessage?: string;
    optional?: TOptional;
  }
): Promise<TOptional extends true ? TResponseBody | undefined : TResponseBody> {
  const response = await fetch(url, requestInit);

  if (
    (!requestInit || requestInit.method === "GET") &&
    response.status === 404 &&
    options?.optional
  ) {
    // @ts-ignore
    return;
  }

  if (response.status >= 400 && response.status < 500) {
    const body = await response.json();

    throw new Error(body.error);
  }

  if (response.status !== 200) {
    throw new Error(
      options?.errorMessage ??
        `Failed to fetch ${url}, got status code ${response.status}`
    );
  }

  const jsonBody = await response.json();

  return schema.parse(jsonBody);
}
