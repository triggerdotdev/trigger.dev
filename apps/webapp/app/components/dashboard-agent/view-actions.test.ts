import type { ActionsBlockAction } from "@internal/dashboard-agent-contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderableActions } from "./view-actions";

const askAction: ActionsBlockAction = {
  label: "Investigate it",
  intent: { kind: "ask", prompt: "Investigate the send-order-receipt failures." },
};

describe("renderableActions", () => {
  it("drops a navigate action whose target isn't a trigger:// URI", () => {
    const actions: ActionsBlockAction[] = [
      askAction,
      { label: "Runs", intent: { kind: "navigate", target: "/runs?status=FAILED" } },
    ];
    expect(renderableActions(actions)).toEqual([askAction]);
  });

  it("keeps a navigate action with a canonical target", () => {
    const navigate: ActionsBlockAction = {
      label: "See its failed runs",
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/runs" },
    };
    expect(renderableActions([navigate])).toEqual([navigate]);
  });

  it("can filter every action out, leaving nothing to render", () => {
    expect(
      renderableActions([{ label: "Nowhere", intent: { kind: "navigate", target: "nope" } }])
    ).toEqual([]);
  });
});

describe("ActionsBlock", () => {
  const source = readFileSync(new URL("./ActionsBlock.tsx", import.meta.url), "utf8");

  it("hands the action's own intent to the host, and renders nothing without one", () => {
    expect(source).toContain("onIntent(action.intent");
    expect(source).toContain("if (!onIntent || renderable.length === 0) return null;");
  });

  it("filters through the shared filter rather than rendering every action", () => {
    expect(source).toContain("renderableActions(block.actions)");
  });

  it("is a pure component: no app hooks, no server module, no Remix", () => {
    expect(source).not.toMatch(/from\s+"~\/hooks\//);
    expect(source).not.toMatch(/from\s+"@remix-run\//);
    expect(source).not.toMatch(/\.server"/);
  });
});
