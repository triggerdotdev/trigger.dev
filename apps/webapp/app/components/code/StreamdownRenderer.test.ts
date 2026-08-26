import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  loadStreamdownRenderer,
  restrictModelUrls,
  retryImport,
  StreamdownRenderer,
} from "./StreamdownRenderer";

// streamdown calls urlTransform(url, key, node) to compute each url attribute; a
// returned undefined removes the attribute, so no request is ever issued.
const img = { tagName: "img" } as any;
const link = { tagName: "a" } as any;

describe("restrictModelUrls (image src)", () => {
  it("drops a remote model-authored image (the favicon beacon)", () => {
    expect(
      restrictModelUrls("https://www.google.com/s2/favicons?domain=evil", "src", img)
    ).toBeUndefined();
  });

  it("drops any absolute or protocol-relative remote image", () => {
    expect(restrictModelUrls("http://evil.tld/pixel.gif", "src", img)).toBeUndefined();
    expect(restrictModelUrls("//evil.tld/pixel.gif", "src", img)).toBeUndefined();
  });

  it("drops a backslash-authority image, which the browser reads as protocol-relative", () => {
    expect(restrictModelUrls("\\\\evil.example/pixel.gif", "src", img)).toBeUndefined();
    expect(restrictModelUrls("/\\evil.example/pixel.gif", "src", img)).toBeUndefined();
  });

  it("drops an image hidden behind a leading C0 control, which the URL parser discards", () => {
    expect(restrictModelUrls("\u0001//evil.tld/p.gif", "src", img)).toBeUndefined();
    expect(restrictModelUrls("\u0000https://evil.tld/p.gif", "src", img)).toBeUndefined();
  });

  it("keeps inline and same-origin images", () => {
    expect(restrictModelUrls("data:image/png;base64,AAAA", "src", img)).toBe(
      "data:image/png;base64,AAAA"
    );
    expect(restrictModelUrls("blob:abc", "src", img)).toBe("blob:abc");
    expect(restrictModelUrls("/local/pic.png", "src", img)).toBe("/local/pic.png");
  });
});

describe("restrictModelUrls (link href)", () => {
  it("keeps http(s), mailto and relative links", () => {
    expect(restrictModelUrls("https://trigger.dev/docs", "href", link)).toBe(
      "https://trigger.dev/docs"
    );
    expect(restrictModelUrls("http://example.com", "href", link)).toBe("http://example.com");
    expect(restrictModelUrls("mailto:hi@trigger.dev", "href", link)).toBe("mailto:hi@trigger.dev");
    expect(restrictModelUrls("/runs/123", "href", link)).toBe("/runs/123");
  });

  it("drops unsafe link schemes", () => {
    expect(restrictModelUrls("javascript:alert(1)", "href", link)).toBeUndefined();
    expect(restrictModelUrls("data:text/html,<script>", "href", link)).toBeUndefined();
  });
});

// Force the lazy component to load, then return its resolved default so we can render it
// synchronously. This proves the policy is actually wired into the JSX, not just exported.
async function resolveStreamdownRenderer() {
  const lazy = StreamdownRenderer as unknown as {
    _payload: unknown;
    _init: (payload: unknown) => (props: { children: string }) => JSX.Element;
  };
  try {
    lazy._init(lazy._payload);
  } catch (thenable) {
    await thenable;
  }
  return lazy._init(lazy._payload);
}

describe("StreamdownRenderer (rendered markdown)", () => {
  it("never lets a model-authored remote image src reach the DOM", async () => {
    const Renderer = await resolveStreamdownRenderer();
    const markdown = [
      "![x](https://www.google.com/s2/favicons?domain=SECRET.evil.tld)",
      "![y](//evil.tld/pixel.gif)",
      "![z](/local/pic.png)",
    ].join("\n\n");
    const html = renderToStaticMarkup(createElement(Renderer, null, markdown));

    // No remote host is ever fetched: no absolute or protocol-relative image src survives.
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('src="//');
    expect(html).not.toContain("SECRET.evil.tld");
    // A same-origin relative image is untouched, so the policy does not over-block.
    expect(html).toContain('src="/local/pic.png"');
  });
});

describe("retryImport", () => {
  it("resolves on first success", async () => {
    const importer = vi.fn().mockResolvedValue("ok");
    await expect(retryImport(importer, [0, 0])).resolves.toBe("ok");
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("retries after failures then succeeds", async () => {
    const importer = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValue("ok");
    await expect(retryImport(importer, [0, 0])).resolves.toBe("ok");
    expect(importer).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting retries", async () => {
    const importer = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(retryImport(importer, [0, 0])).rejects.toThrow("always fails");
    expect(importer).toHaveBeenCalledTimes(3);
  });
});

describe("loadStreamdownRenderer", () => {
  it("resolves to a plain-text fallback when the chunk load keeps failing", async () => {
    // The fallback path re-raises as an unhandled rejection (for StaleAssetRecovery); swap
    // in our own listener so it's asserted on, not reported as a test-runner failure.
    const priorListeners = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    const caught = new Promise<Error>((resolve) => {
      process.once("unhandledRejection", (err) => resolve(err as Error));
    });

    const mod = await loadStreamdownRenderer(() => Promise.reject(new Error("boom")), [0, 0]);
    const html = renderToStaticMarkup(createElement(mod.default, null, "hello **world**"));
    expect(html).toContain("hello");

    const dispatched = await caught;
    expect(dispatched.message).toMatch(/boom/);

    for (const listener of priorListeners) {
      process.on("unhandledRejection", listener as NodeJS.UnhandledRejectionListener);
    }
  });
});
