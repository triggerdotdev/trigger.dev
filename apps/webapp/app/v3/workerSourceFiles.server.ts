import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { createInflate, inflate } from "node:zlib";
import pLimit from "p-limit";
import { env } from "~/env.server";
import { ServiceValidationError } from "./services/common.server";

const inflateAsync = promisify(inflate);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type WorkerSourceLimits = {
  perFileBytes: number;
  totalBytes: number;
};

function workerSourceLimits(): WorkerSourceLimits {
  return {
    perFileBytes: env.WORKER_SOURCE_FILE_MAX_INFLATED_BYTES,
    totalBytes: env.WORKER_SOURCE_MAX_TOTAL_INFLATED_BYTES,
  };
}

export class WorkerSourceTooLargeError extends Error {
  constructor(
    readonly limit: "file" | "total",
    readonly limitBytes: number
  ) {
    super(`Inflated source passes the ${limit} limit of ${limitBytes} bytes`);
    this.name = "WorkerSourceTooLargeError";
  }
}

class WorkerSourceInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerSourceInvalidError";
  }
}

/** Source file contents are base64 of deflate output, as the CLI sends them. */
export function decodeWorkerSource(contents: string | Uint8Array): Buffer {
  const text = typeof contents === "string" ? contents : Buffer.from(contents).toString("utf-8");
  if (!BASE64.test(text)) {
    throw new WorkerSourceInvalidError("Source is not valid base64");
  }
  return Buffer.from(text, "base64");
}

/**
 * Bytes these UTF-8 bytes take inside a JSON string, without building it. The bytes JSON escapes
 * are all ASCII, so this works on any chunk boundary. Assumes valid UTF-8: upload refuses
 * anything else, and the read path adds what invalid bytes grow to when decoded.
 */
export function jsonEscapedLength(bytes: Uint8Array): number {
  let length = bytes.length;
  for (const b of bytes) {
    if (
      b === 0x22 ||
      b === 0x5c ||
      b === 0x08 ||
      b === 0x09 ||
      b === 0x0a ||
      b === 0x0c ||
      b === 0x0d
    ) {
      length += 1;
    } else if (b < 0x20) {
      length += 5;
    }
  }
  return length;
}

type InflatedSize = { rawBytes: number; escapedBytes: number };

/**
 * Counts a file's inflated and JSON-escaped size without keeping the output, and checks it is
 * valid UTF-8. Stops as soon as the inflated size passes `maxRawBytes` or the escaped size passes
 * `maxEscapedBytes`.
 */
export function measureInflatedSize(
  compressed: Buffer,
  maxRawBytes: number,
  maxEscapedBytes: number
): Promise<InflatedSize> {
  return new Promise((resolve, reject) => {
    const inflater = createInflate();
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    const size: InflatedSize = { rawBytes: 0, escapedBytes: 2 };
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      reject(error);
    };

    inflater.on("data", (chunk: Buffer) => {
      if (settled) return;
      try {
        utf8.decode(chunk, { stream: true });
      } catch {
        return fail(new WorkerSourceInvalidError("Source is not valid UTF-8"));
      }
      size.rawBytes += chunk.length;
      size.escapedBytes += jsonEscapedLength(chunk);
      if (size.rawBytes > maxRawBytes) {
        fail(new WorkerSourceTooLargeError("file", maxRawBytes));
      } else if (size.escapedBytes > maxEscapedBytes) {
        fail(new WorkerSourceTooLargeError("total", maxEscapedBytes));
      }
    });
    inflater.on("end", () => {
      if (settled) return;
      try {
        utf8.decode();
      } catch {
        return fail(new WorkerSourceInvalidError("Source is not valid UTF-8"));
      }
      // An empty file emits no data, so its two quote bytes are only checked here.
      if (size.escapedBytes > maxEscapedBytes) {
        return fail(new WorkerSourceTooLargeError("total", maxEscapedBytes));
      }
      settled = true;
      resolve(size);
    });
    inflater.on("error", (error) => fail(new WorkerSourceInvalidError(error.message)));
    inflater.end(compressed);
  });
}

/** Inflates without ever holding more than `maxBytes` of output. */
export async function inflateWithin(compressed: Buffer, maxBytes: number): Promise<Buffer> {
  try {
    return await inflateAsync(compressed, { maxOutputLength: maxBytes });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new WorkerSourceTooLargeError("file", maxBytes);
    }
    throw new WorkerSourceInvalidError(error instanceof Error ? error.message : String(error));
  }
}

function formatMiB(bytes: number) {
  return `${Math.round((bytes / 1024 / 1024) * 100) / 100} MiB`;
}

/**
 * Refuses uploaded source files that inflate past the per-file limit, whose JSON-escaped contents
 * together pass the per-worker limit (the same measure the read API uses), or that aren't valid
 * compressed UTF-8 text. Stops at the first byte past a limit.
 */
export async function assertSourceFilesWithinLimits(
  files: ReadonlyArray<{ filePath: string; contents: string }> | undefined,
  limits: WorkerSourceLimits = workerSourceLimits()
): Promise<void> {
  let escapedBytes = 0;

  for (const file of files ?? []) {
    try {
      const size = await measureInflatedSize(
        decodeWorkerSource(file.contents),
        limits.perFileBytes,
        limits.totalBytes - escapedBytes
      );
      escapedBytes += size.escapedBytes;
    } catch (error) {
      if (error instanceof WorkerSourceInvalidError) {
        throw new ServiceValidationError(
          `Source file "${file.filePath}" could not be read: its contents are not valid compressed UTF-8 text.`,
          400
        );
      }
      if (error instanceof WorkerSourceTooLargeError && error.limit === "file") {
        throw new ServiceValidationError(
          `Source file "${file.filePath}" is too large: it expands to more than ${formatMiB(
            limits.perFileBytes
          )}.`,
          413
        );
      }
      if (error instanceof WorkerSourceTooLargeError) {
        throw new ServiceValidationError(
          `This worker's source files are too large: together they expand to more than ${formatMiB(
            limits.totalBytes
          )} (limit reached at "${file.filePath}").`,
          413
        );
      }
      throw error;
    }
  }
}

/**
 * Inflates stored source files for an API response. Throws WorkerSourceTooLargeError when one
 * file passes the per-file limit or the JSON-escaped contents together pass the per-worker limit.
 */
export async function inflateSourceFilesForResponse<T extends { contents: Uint8Array }>(
  files: ReadonlyArray<T>,
  limits: WorkerSourceLimits = workerSourceLimits()
): Promise<Array<{ file: T; contents: string }>> {
  const results: Array<{ file: T; contents: string }> = [];
  let escapedBytes = 0;

  for (const file of files) {
    const inflated = await inflateWithin(decodeWorkerSource(file.contents), limits.perFileBytes);

    const contents = inflated.toString("utf-8");

    // Rows stored before upload checked UTF-8 can hold invalid bytes, each 3 bytes once decoded.
    escapedBytes +=
      jsonEscapedLength(inflated) + 2 + (Buffer.byteLength(contents) - inflated.length);
    if (escapedBytes > limits.totalBytes) {
      throw new WorkerSourceTooLargeError("total", limits.totalBytes);
    }

    results.push({ file, contents });
  }

  return results;
}

/** About 30k tokens: enough to find a task's schema without sending a whole bundle to a model. */
const PROMPT_SOURCE_MAX_BYTES = 128 * 1024;

/** Inflates only the first `maxBytes` of a file, stopping the stream there. */
function inflatePrefix(
  compressed: Buffer,
  maxBytes: number
): Promise<{ bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const inflater = createInflate();
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    inflater.on("data", (chunk: Buffer) => {
      if (settled) return;
      const room = maxBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        settled = true;
        inflater.destroy();
        resolve({ bytes: Buffer.concat(chunks), truncated: true });
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    inflater.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ bytes: Buffer.concat(chunks), truncated: false });
    });
    inflater.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new WorkerSourceInvalidError(error.message));
    });
    inflater.end(compressed);
  });
}

/** The start of one stored source file for a model prompt, with a note when it was cut. */
export async function sourceForPrompt(
  contents: Uint8Array,
  maxBytes = PROMPT_SOURCE_MAX_BYTES
): Promise<string> {
  const { bytes, truncated } = await inflatePrefix(decodeWorkerSource(contents), maxBytes);
  // StringDecoder holds back a multi-byte character cut at the end instead of mangling it.
  const text = new StringDecoder("utf8").write(bytes);
  if (!truncated) return text;

  return `${text}\n\n[Truncated: showing the first ${maxBytes} bytes of this file.]`;
}

export type QueuedRead<T> =
  | { status: "done"; value: T }
  | { status: "busy" }
  | { status: "aborted" };

export type ReadLease = {
  /** Fires when the response has been sent or the client has gone. */
  signal: AbortSignal;
  /** Called when the response is still unsent after `maxHoldMs`, to drop the client. */
  onHoldExpired?: () => void;
};

/**
 * Runs reads `concurrency` at a time, refusing new ones when `maxPending` are already waiting.
 * A read keeps its slot until its response has been sent (the lease signal fires), since the
 * response body stays in memory until then; after `maxHoldMs` the client is dropped. A waiting
 * read whose client has gone is skipped.
 */
export function createBoundedReadQueue({
  concurrency,
  maxPending,
  maxHoldMs,
}: {
  concurrency: number;
  maxPending: number;
  maxHoldMs: number;
}) {
  const limit = pLimit(concurrency);

  return {
    run<T>(lease: ReadLease, read: () => Promise<T>): Promise<QueuedRead<T>> {
      // Counts running and waiting reads together, so a maxPending of 0 still admits a read
      // into a free slot.
      if (limit.activeCount + limit.pendingCount >= concurrency + maxPending) {
        return Promise.resolve({ status: "busy" });
      }

      return new Promise((resolve, reject) => {
        void limit(async () => {
          if (lease.signal.aborted) return resolve({ status: "aborted" });

          let value: T;
          try {
            value = await read();
          } catch (error) {
            return reject(error);
          }
          resolve({ status: "done", value });

          const sent = await abortedWithin(lease.signal, maxHoldMs);
          if (!sent) lease.onHoldExpired?.();
        });
      });
    },
  };
}

function abortedWithin(signal: AbortSignal, ms: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);

  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
