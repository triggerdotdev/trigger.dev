import type { IncomingMessage, RequestListener } from "node:http";

export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Request body exceeds the limit of ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export type GetJsonBodyOptions = {
  /** Maximum request body size in bytes. Defaults to 1 MiB. */
  maxBytes?: number;
  /** Called with the body size in bytes once the whole body has been read. */
  onBodyRead?: (bytes: number) => void;
};

/**
 * Reads and parses a JSON request body. Rejects with a `RequestBodyTooLargeError`
 * once the body is larger than `maxBytes`, and stops reading the request.
 */
export async function getJsonBody(
  req: IncomingMessage,
  options: GetJsonBodyOptions = {}
): Promise<any> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;

  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers["content-length"]);

    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      req.pause();
      reject(new RequestBodyTooLargeError(maxBytes));
      return;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      receivedBytes += buffer.byteLength;

      if (receivedBytes > maxBytes) {
        cleanup();
        chunks.length = 0;
        req.pause();
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }

      chunks.push(buffer);
    };

    const onEnd = () => {
      cleanup();
      options.onBodyRead?.(receivedBytes);
      resolve(safeJsonParse(Buffer.concat(chunks).toString("utf8")));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Request closed before the body was fully read"));
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

function safeJsonParse(text: string) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("Failed to parse JSON", { error, length: text.length });
    return null;
  }
}

export class HttpReply {
  constructor(private response: Parameters<RequestListener>[1]) {}

  empty(status?: number) {
    if (this.hasReplied) {
      return;
    }

    return this.response.writeHead(status ?? 200).end();
  }

  text(text: string, status?: number, contentType?: string) {
    if (this.hasReplied) {
      return;
    }

    return this.response
      .writeHead(status ?? 200, { "Content-Type": contentType || "text/plain" })
      .end(text.endsWith("\n") ? text : `${text}\n`);
  }

  json(value: any, pretty?: boolean, status?: number) {
    if (this.hasReplied) {
      return;
    }

    return this.text(
      JSON.stringify(value, undefined, pretty ? 2 : undefined),
      status ?? 200,
      "application/json"
    );
  }

  get hasReplied() {
    return this.response.headersSent;
  }
}

function getRandomInteger(min: number, max: number) {
  const intMin = Math.ceil(min);
  const intMax = Math.floor(max);
  return Math.floor(Math.random() * (intMax - intMin + 1)) + intMin;
}

export function getRandomPortNumber() {
  return getRandomInteger(8000, 9999);
}
