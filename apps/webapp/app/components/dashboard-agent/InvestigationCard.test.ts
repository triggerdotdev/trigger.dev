import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `InvestigationCard` is a pure component: props in, markup out. That's what
 * lets the same card render in the panel, in the storybook gallery, and in any
 * future host — and it's easy to break with one convenient `useLoaderData`. So
 * it's asserted here rather than left to review (same guard as `ReportView`).
 *
 * The one hook it may use is `useState`, for the hypotheses disclosure: that's
 * local UI state, not host data.
 */
const source = readFileSync(new URL("./InvestigationCard.tsx", import.meta.url), "utf8");

describe("InvestigationCard purity", () => {
  it("imports nothing from Remix", () => {
    expect(source).not.toMatch(/from\s+"@remix-run\//);
  });

  it("imports no app hooks and no server module", () => {
    expect(source).not.toMatch(/from\s+"~\/hooks\//);
    expect(source).not.toMatch(/\.server"/);
  });

  it("calls no hook other than useState", () => {
    const hooks = [...source.matchAll(/\buse([A-Z]\w*)\(/g)].map((match) => `use${match[1]}`);
    expect([...new Set(hooks)]).toEqual(["useState"]);
  });

  it("resolves evidence URIs through the host, never a route of its own", () => {
    expect(source).toMatch(/resolveUri/);
    expect(source).not.toMatch(/\/orgs\//);
  });

  it("hands its actions to the host as intents, and never composes its own", () => {
    // The actions row is exactly the chart's seam: the button emits the block's
    // intent and the host decides. So the card reads `capabilities.actions` and
    // calls `onIntent` — it never builds a prompt or a target itself.
    expect(source).toMatch(/capabilities\?\.actions/);
    expect(source).toMatch(/onIntent\(action\.intent\)/);
    expect(source).not.toMatch(/kind:\s*"(ask|navigate)"/);
    // The same row component the rest of the chat uses, so there's one button row.
    expect(source).toMatch(/ChatActionsRow/);
  });

  it("renders nothing action-shaped without a host to hand intents to", () => {
    expect(source).toMatch(/if \(!onIntent \|\| actions\.length === 0\) return null;/);
  });
});
