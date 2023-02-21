import { RequestResponse } from "core/request/types";
import { type Response } from "node-fetch";

export async function getFetch() {
  return (await import("node-fetch")).default;
}

export async function safeGetJson(response: Response) {
  try {
    return await response.json();
  } catch (error) {
    return undefined;
  }
}

export function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};

  headers.forEach((value, key) => {
    normalizedHeaders[key.toLowerCase()] = value;
  });

  return normalizedHeaders;
}

export function responseFromCaughtError(error: any): RequestResponse {
  if (error instanceof Error) {
    return {
      success: false,
      status: 400,
      headers: {},
      body: { error: error.message },
    };
  }

  //convert the error into JSON
  return {
    success: false,
    status: 400,
    headers: {},
    body: { error: JSON.stringify(error) },
  };
}
