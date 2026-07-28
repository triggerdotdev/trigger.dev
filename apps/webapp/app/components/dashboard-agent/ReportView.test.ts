import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `ReportView` and the skin it wears are pure components: props in, markup out.
 * That's the property that lets the same card render in the panel, in the
 * storybook gallery, and in any future host (the skin is the intended MCP-UI
 * report surface) — and it's easy to break with one convenient `useLoaderData`.
 * So it's asserted here rather than left to review.
 */
const sources = {
  ReportView: readFileSync(new URL("./ReportView.tsx", import.meta.url), "utf8"),
  "report-skin": readFileSync(new URL("./report-skin.tsx", import.meta.url), "utf8"),
};

describe.each(Object.entries(sources))("%s purity", (_name, source) => {
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

describe("report skin", () => {
  const skin = sources["report-skin"];

  it("owns no report vocabulary", () => {
    // The skin renders strings the caller has already resolved through a message
    // catalog. If it starts importing one, prose has leaked into the layout.
    expect(skin).not.toMatch(/report-messages|health-messages|report-view-model/);
  });

  it("uses the design system's buttons for actions", () => {
    // Nothing clickable in a report may look like plain text.
    expect(skin).toMatch(/from\s+"~\/components\/primitives\/Buttons"/);
  });

  it("keeps the sparkline in the left-aligned content column", () => {
    // A right-aligned or floated sparkline breaks the alignment the skin exists
    // to provide, so no such class may appear on it.
    const spark = skin.slice(skin.indexOf("export function ReportSpark"));
    expect(spark.slice(0, 400)).not.toMatch(/ml-auto|justify-end|text-right/);
  });
});
