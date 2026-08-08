import { investigationCapabilitiesSchema } from "@internal/dashboard-agent-contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    expect(source).toMatch(/capabilities\?\.actions/);
    expect(source).toMatch(/onIntent\(action\.intent\)/);
    expect(source).not.toMatch(/kind:\s*"(ask|navigate)"/);
    expect(source).toMatch(/ChatActionsRow/);
  });

  it("renders no spinner — the transcript owns the one live progress element", () => {
    // A spinner in the card would restart on every revision.
    expect(source).not.toMatch(/AgentSpinner|ChatProgress|ChatPendingTool/);
  });

  it("renders nothing action-shaped without a host to hand intents to", () => {
    expect(source).toMatch(/if \(!onIntent \|\| actions\.length === 0\) return null;/);
  });
});

describe("InvestigationCard action rows", () => {
  const twoOfAKind = {
    version: 1,
    actions: [
      { kind: "ask_follow_up", label: "Why the retries?", intent: { kind: "ask", prompt: "Why?" } },
      {
        kind: "ask_follow_up",
        label: "Why the timeouts?",
        intent: { kind: "ask", prompt: "How?" },
      },
    ],
  };

  it("can be handed two actions of the same kind", () => {
    const parsed = investigationCapabilitiesSchema.safeParse(twoOfAKind);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.actions).toHaveLength(2);
  });

  // Structural: there is no DOM in this suite, so the key is read off the source.
  it("keys the rows by position, which two of a kind cannot collide on", () => {
    const row = source.match(/actions\.map\(\(action, i\) => \([\s\S]*?key=\{(.+?)\}/);
    expect(row?.[1]).toBe("i");
  });
});
