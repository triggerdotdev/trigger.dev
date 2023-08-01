import { z } from "zod";

export async function zodfetch<TResponseBody extends any>(
  schema: z.Schema<TResponseBody>,
  url: string,
  requestInit?: RequestInit
): Promise<TResponseBody> {
  const response = await fetch(url, requestInit);

  if ((!requestInit || requestInit.method === "GET") && response.status === 404) {
    // @ts-ignore
    return;
  }

  //todo improve error handling

  if (response.status >= 400 && response.status < 500) {
    const body = await response.json();

    throw new Error(body.error);
  }

  if (response.status !== 200) {
    throw new Error(`Failed to fetch ${url}, got status code ${response.status}`);
  }

  const jsonBody = await response.json();

  return schema.parse(jsonBody);
}
