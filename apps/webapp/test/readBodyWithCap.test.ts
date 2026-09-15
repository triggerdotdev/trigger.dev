import { describe, expect, it } from "vitest";
import { readBodyWithCap } from "~/utils/readBodyWithCap.server";

function streamingRequest(chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
  return new Request("https://example.com/ingest", {
    method: "POST",
    body,
    // @ts-expect-error duplex isn't in the lib types yet but Node requires it for a stream body
    duplex: "half",
  });
}

const chunk = (n: number) => new Uint8Array(n).fill(122);

describe("readBodyWithCap", () => {
  it("returns the full body when under the cap", async () => {
    const bytes = await readBodyWithCap(streamingRequest([chunk(100), chunk(100)]), 1024);
    expect(bytes).not.toBeNull();
    expect(bytes!.byteLength).toBe(200);
  });

  it("returns null when the streamed body exceeds the cap (no full buffering)", async () => {
    const bytes = await readBodyWithCap(
      streamingRequest([chunk(1024), chunk(1024), chunk(1024)]),
      2048
    );
    expect(bytes).toBeNull();
  });

  it("treats an empty body as zero bytes", async () => {
    const bytes = await readBodyWithCap(
      new Request("https://example.com/ingest", { method: "POST" }),
      1024
    );
    expect(bytes).not.toBeNull();
    expect(bytes!.byteLength).toBe(0);
  });
});
