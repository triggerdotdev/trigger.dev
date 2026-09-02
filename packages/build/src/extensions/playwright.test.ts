import { describe, expect, it } from "vitest";
import type { BuildContext, BuildLayer } from "@trigger.dev/core/v3/build";
import { playwright } from "./playwright.js";

// Real `playwright install --dry-run` headers, before and after the 1.58 format change.
const HEADERS = {
  "1.57": {
    chromium: "browser: chromium version 143.0.7499.4",
    "chromium-headless-shell": "browser: chromium-headless-shell version 143.0.7499.4",
    firefox: "browser: firefox version 144.0.2",
    webkit: "browser: webkit version 26.0",
  },
  "1.62": {
    chromium: "Chrome for Testing 151.0.7922.34 (playwright chromium v1234)",
    "chromium-headless-shell":
      "Chrome Headless Shell 151.0.7922.34 (playwright chromium-headless-shell v1234)",
    firefox: "Firefox 153.0 (playwright firefox v1538)",
    webkit: "WebKit 26.5 (playwright webkit v2336)",
  },
} as const;

type BrowserKey = keyof (typeof HEADERS)["1.57"];

function generatedInstructions(options: Parameters<typeof playwright>[0]): string[] {
  let captured: BuildLayer | undefined;

  const context = {
    target: "deploy",
    logger: { debug: () => {} },
    addLayer: (layer: BuildLayer) => {
      captured = layer;
    },
  } as unknown as BuildContext;

  const manifest = {
    externals: [{ name: "playwright", version: "1.62.0" }],
  } as any;

  playwright(options).onBuildComplete!(context, manifest);

  return captured?.image?.instructions ?? [];
}

/** The ERE the generated `grep -E "<pattern>"` step selects a browser's block with. */
function headerPattern(instructions: string[], browser: BrowserKey): RegExp {
  const step = instructions.find((line) => line.endsWith(`> /tmp/${browser}-info.txt`));
  const match = step?.match(/grep [^"]*"(.+)" \/tmp\/browser-info\.txt/);
  if (!match?.[1]) throw new Error(`no header grep generated for ${browser}`);
  return new RegExp(match[1]);
}

describe("playwright extension dry-run header parsing", () => {
  const instructions = generatedInstructions({
    browsers: ["chromium", "firefox", "webkit"],
    headless: false,
  });
  const browsers = Object.keys(HEADERS["1.57"]) as BrowserKey[];

  it.each(browsers)("selects the %s block in both output formats", (browser) => {
    const pattern = headerPattern(instructions, browser);

    expect(pattern.test(HEADERS["1.57"][browser])).toBe(true);
    expect(pattern.test(HEADERS["1.62"][browser])).toBe(true);
  });

  it.each(browsers)("does not select another browser's block for %s", (browser) => {
    const pattern = headerPattern(instructions, browser);

    for (const other of browsers.filter((b) => b !== browser)) {
      expect(pattern.test(HEADERS["1.57"][other])).toBe(false);
      expect(pattern.test(HEADERS["1.62"][other])).toBe(false);
    }
  });
});
