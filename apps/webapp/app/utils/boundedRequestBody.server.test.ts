import { describe, expect, it } from "vitest";
import { readBoundedBodyText } from "./boundedRequestBody.server";

/** A body with no `content-length`, delivered in chunks, counting what was pulled. */
function streamed(chunkCount: number, chunkBytes: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunkCount) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(97));
    },
  });

  const request = new Request("http://localhost/in", {
    method: "POST",
    body,
    // @ts-expect-error — required for a streamed request body.
    duplex: "half",
  });
  return { request, pulled: () => pulled };
}

describe("readBoundedBodyText", () => {
  it("returns a body under the limit", async () => {
    const { request } = streamed(2, 8);
    expect(await readBoundedBodyText(request, 1024)).toEqual({ ok: true, text: "a".repeat(16) });
  });

  it("stops reading as soon as the limit is crossed", async () => {
    const { request, pulled } = streamed(100, 64);

    expect(await readBoundedBodyText(request, 128)).toEqual({ ok: false, reason: "too_large" });
    // Three chunks: two fit, the third crossed it. Nothing beyond was ever pulled.
    expect(pulled()).toBe(3);
  });

  it("treats a missing body as empty", async () => {
    const request = new Request("http://localhost/in", { method: "POST" });
    expect(await readBoundedBodyText(request, 8)).toEqual({ ok: true, text: "" });
  });
});
