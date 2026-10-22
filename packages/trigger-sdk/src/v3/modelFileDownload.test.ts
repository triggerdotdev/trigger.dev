import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicFile } from "./modelFileDownload.js";

describe("fetchPublicFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string) => Response) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL | string) => {
      calls.push(String(input));
      return handler(String(input));
    });
    return calls;
  }

  it.each([
    "http://127.0.0.1/a.png",
    "http://localhost:3000/a.png",
    "http://10.0.0.5/a.png",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.1.1/a.png",
    "http://[::1]/a.png",
    "http://[::ffff:127.0.0.1]/a.png",
    "http://[fd00::1]/a.png",
    "http://printer.local/a.png",
    "ftp://example.com/a.png",
  ])("refuses %s without fetching it", async (url) => {
    const calls = stubFetch(() => new Response("secret"));
    await expect(fetchPublicFile(new URL(url))).rejects.toThrow(/Refusing to download/);
    expect(calls).toEqual([]);
  });

  it("fetches a public file", async () => {
    stubFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })
    );
    await expect(fetchPublicFile(new URL("https://cdn.example.com/a.png"))).resolves.toEqual({
      data: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    });
  });

  it("checks each redirect target", async () => {
    const calls = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })
    );
    await expect(fetchPublicFile(new URL("https://cdn.example.com/a.png"))).rejects.toThrow(
      /Refusing to download http:\/\/127.0.0.1\/admin/
    );
    expect(calls).toEqual(["https://cdn.example.com/a.png"]);
  });

  it("refuses a body over the size cap", async () => {
    stubFetch(() => new Response(new Uint8Array(11)));
    await expect(fetchPublicFile(new URL("https://cdn.example.com/a.bin"), 10)).rejects.toThrow(
      /larger than 10 bytes/
    );
  });
});
