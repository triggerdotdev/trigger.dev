import { describe, expect, it } from "vitest";
import type { BuildContext, BuildLayer } from "@trigger.dev/core/v3/build";
import type { BuildManifest } from "@trigger.dev/core/v3";
import { playwright } from "./playwright.js";

function runExtension(browsers: ("chromium" | "firefox" | "webkit")[]): BuildLayer | undefined {
  let captured: BuildLayer | undefined;

  const context = {
    target: "deploy",
    config: { project: "proj_test" },
    logger: {
      debug() {},
    },
    addLayer: (layer: BuildLayer) => {
      captured = layer;
    },
  } as unknown as BuildContext;

  const manifest = {
    externals: [{ name: "playwright", version: "1.58.0" }],
  } as unknown as BuildManifest;

  playwright({ browsers }).onBuildComplete!(context, manifest);

  return captured;
}

describe("playwright extension browser metadata parsing", () => {
  it("matches the legacy and Playwright 1.58 dry-run headers", () => {
    const instructions = runExtension(["chromium"])?.image?.instructions ?? [];

    expect(instructions).toContain(
      "RUN grep -A5 -m1 -E '^(browser: chromium-headless-shell( |$)|.*\\(playwright chromium-headless-shell v)' /tmp/browser-info.txt > /tmp/chromium-headless-shell-info.txt"
    );
  });

  it("uses a browser-specific selector for each requested browser", () => {
    const instructions = runExtension(["chromium", "firefox"])?.image?.instructions ?? [];

    expect(instructions).toContain(
      "RUN grep -A5 -m1 -E '^(browser: chromium-headless-shell( |$)|.*\\(playwright chromium-headless-shell v)' /tmp/browser-info.txt > /tmp/chromium-headless-shell-info.txt"
    );
    expect(instructions).toContain(
      "RUN grep -A5 -m1 -E '^(browser: firefox( |$)|.*\\(playwright firefox v)' /tmp/browser-info.txt > /tmp/firefox-info.txt"
    );
  });
});
