import { basename, extname } from "node:path";
import { TRANSCRIPT_BLOB_CONTENT_TYPE } from "@trigger.dev/core/v3";

/** Pass through the object body and media type, using .jsonl for indexed transcripts. */
export function downloadTranscript(
  object: Response,
  storagePath: string,
  onStreamError?: (error: unknown) => void
): Response {
  const storedFilename = basename(storagePath).replace(/[^a-zA-Z0-9._-]/g, "_") || "transcript";
  const contentType = object.headers.get("Content-Type") ?? "application/octet-stream";
  const filename =
    contentType.split(";")[0]?.trim() === TRANSCRIPT_BLOB_CONTENT_TYPE
      ? `${basename(storedFilename, extname(storedFilename))}.jsonl`
      : storedFilename;
  // Errors after the route returns must still be logged and reach the HTTP adapter,
  // which destroys the response so a truncated file is not reported as complete.
  const reader = object.body?.getReader();
  const body = reader
    ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (error) {
            onStreamError?.(error);
            controller.error(error);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      })
    : null;
  return new Response(body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function isTranscriptNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (name === "NoSuchKey" || name === "NotFound" || $metadata?.httpStatusCode === 404) return true;
  // The aws4fetch adapter currently reports the HTTP status text in its error.
  return (
    error instanceof Error &&
    /^Failed to download(?: range)? from object store: Not Found$/.test(error.message)
  );
}
