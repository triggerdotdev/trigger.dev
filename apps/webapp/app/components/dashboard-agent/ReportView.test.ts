import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `ReportView` is a pure component: props in, markup out, so the same card
 * renders in the panel, the storybook gallery and any future host.
 */
const source = readFileSync(new URL("./ReportView.tsx", import.meta.url), "utf8");

describe("ReportView purity", () => {
  it("imports nothing from Remix", () => {
    expect(source).not.toMatch(/from\s+"@remix-run\//);
  });

  it("imports no hooks and no server module", () => {
    expect(source).not.toMatch(/from\s+"~\/hooks\//);
    expect(source).not.toMatch(/\.server"/);
  });

  it("calls no React hook of its own", () => {
    expect(source).not.toMatch(/\buse[A-Z]\w*\(/);
  });
});
