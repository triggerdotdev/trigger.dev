import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `ReportView` is a pure component: props in, markup out. That's the property
 * that lets the same card render in the panel, in the storybook gallery, and in
 * any future host — and it's easy to break with one convenient `useLoaderData`.
 * So it's asserted here rather than left to review.
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
    // A pure render needs no state, no effects, no context.
    expect(source).not.toMatch(/\buse[A-Z]\w*\(/);
  });
});
