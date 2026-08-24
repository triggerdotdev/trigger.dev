// Read a request body, aborting as soon as the accumulated bytes exceed `limitBytes`. A chunked
// upload can omit or understate Content-Length, so reading the stream incrementally (instead of
// request.arrayBuffer(), which buffers the whole stream first) caps the memory a single request can
// force us to hold before rejection. Returns null when the body is over the limit.
export async function readBodyWithCap(
  request: Request,
  limitBytes: number
): Promise<Uint8Array | null> {
  if (!request.body) {
    return new Uint8Array(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
