/**
 * Reading a request body with a ceiling. `request.text()` buffers the whole body before the
 * caller can look at its size, so a route that only checks afterwards has already paid for it.
 */
export type BoundedBody = { ok: true; text: string } | { ok: false; reason: "too_large" };

/** Stops at the first chunk that crosses `maxBytes` and cancels the stream. */
export async function readBoundedBodyText(
  request: Request,
  maxBytes: number
): Promise<BoundedBody> {
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}
