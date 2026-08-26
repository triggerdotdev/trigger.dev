import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Structural guard: a live SSE resume is impractical in jsdom, so this pins the wiring
// instead. `opened-chat.test.ts` covers the `streaming` value; this covers it reaching the transport.
describe("the panel's resume wiring, source-checked", () => {
  const chat = readFileSync(new URL("./DashboardAgentChat.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./DashboardAgentPanel.tsx", import.meta.url), "utf8");

  it("marks a reopened chat's session isStreaming from the `streaming` prop", () => {
    expect(chat).toContain("isStreaming: streaming ?? false");
  });

  it("only stopGeneration is called from the explicit Stop button and the gated teardown", () => {
    const calls = [...chat.matchAll(/transport\.stopGeneration\(/g)];
    expect(calls).toHaveLength(1);
    expect(chat).toContain("if (!teardownCancelsTurn(reason)) return;");
  });

  it("passes the opened chat's streaming flag through to the mounted chat", () => {
    expect(panel).toContain("setActive({ ...opened, organizationId: organization.id });");
    expect(panel).toContain("streaming={active.streaming}");
  });
});
