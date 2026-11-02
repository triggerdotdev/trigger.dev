import { MAX_INLINE_BYTES, REQUEST_TIMEOUT_MS, type Config } from "./shared.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public retryable: boolean
  ) {
    super(message);
  }
}

export async function request(
  config: Config,
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.baseUrl + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${config.secretKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      const retryHeader = response.headers.get("x-should-retry");
      // Never persist response bodies, which could contain credentials or payloads.
      throw new ApiError(
        `Trigger.dev API returned HTTP ${response.status}`,
        retryHeader === "true" ||
          (retryHeader !== "false" &&
            (response.status === 408 ||
              response.status === 409 ||
              response.status === 429 ||
              response.status >= 500))
      );
    }
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ApiError("Invalid Trigger.dev response", true);
    }
    return data as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

export function inlineValue(value: unknown): { value?: any; omitted: boolean } {
  if (value === undefined) return { omitted: false };
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_INLINE_BYTES) {
    return { omitted: true };
  }
  return { value, omitted: false };
}
