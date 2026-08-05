import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `InvestigationCard` is a pure component: props in, markup out, so the same
 * card renders in the panel, the storybook gallery and any future host. The one
 * hook it may use is `useState`, for the hypotheses disclosure.
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
    // The button emits the block's intent and the host decides: the card reads
    // `capabilities.actions` and calls `onIntent`, never building an intent itself.
    expect(source).toMatch(/capabilities\?\.actions/);
    expect(source).toMatch(/onIntent\(action\.intent\)/);
    expect(source).not.toMatch(/kind:\s*"(ask|navigate)"/);
    expect(source).toMatch(/ChatActionsRow/);
  });

  it("renders no spinner — the transcript owns the one live progress element", () => {
    // The card is re-emitted as the investigation progresses, so a spinner inside
    // it would restart on every revision. The transcript's progress line wears
    // the card's `progress` phrase instead.
    expect(source).not.toMatch(/AgentSpinner|ChatProgress|ChatPendingTool/);
  });

  it("renders nothing action-shaped without a host to hand intents to", () => {
    expect(source).toMatch(/if \(!onIntent \|\| actions\.length === 0\) return null;/);
  });
});
