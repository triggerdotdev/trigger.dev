import { describe, expect, it } from "vitest";
import { dryRunHeaderPattern } from "./playwright.js";

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

const browsers = Object.keys(HEADERS["1.57"]) as Array<keyof (typeof HEADERS)["1.57"]>;

describe("playwright extension dry-run header pattern", () => {
  it.each(browsers)("selects the %s block in both output formats", (browser) => {
    const pattern = new RegExp(dryRunHeaderPattern(browser));

    expect(pattern.test(HEADERS["1.57"][browser])).toBe(true);
    expect(pattern.test(HEADERS["1.62"][browser])).toBe(true);
  });

  it.each(browsers)("does not select another browser's block for %s", (browser) => {
    const pattern = new RegExp(dryRunHeaderPattern(browser));

    for (const other of browsers.filter((b) => b !== browser)) {
      expect(pattern.test(HEADERS["1.57"][other])).toBe(false);
      expect(pattern.test(HEADERS["1.62"][other])).toBe(false);
    }
  });
});
