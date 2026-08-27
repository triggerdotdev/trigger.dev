import { describe, expect, it } from "vitest";
import type { AgentPageContext } from "@internal/dashboard-agent-contracts";
import { contextualPromptsBySlot } from "./signal-prompts";

function contextWith(signal: AgentPageContext["signals"][number]): AgentPageContext {
  return {
    page: { kind: "runs" },
    signals: [signal],
  };
}

describe("concurrency_saturation prompt", () => {
  it("names the queue when scope is queue", () => {
    const bySlot = contextualPromptsBySlot(
      contextWith({
        kind: "concurrency_saturation",
        severity: "crit",
        scope: "queue",
        queueName: "black-friday",
      }),
      Date.now()
    );

    expect(bySlot.watch[0]?.prompt).toBe(
      "Why is the black-friday queue at its concurrency limit? Watch it and tell me when the backlog drains."
    );
  });

  it("falls back to generic wording when scope is env", () => {
    const bySlot = contextualPromptsBySlot(
      contextWith({ kind: "concurrency_saturation", severity: "crit", scope: "env" }),
      Date.now()
    );

    expect(bySlot.watch[0]?.prompt).toBe(
      "Concurrency is saturated right now. Watch it and tell me when the backlog drains."
    );
  });

  it("falls back to generic wording when identity is absent", () => {
    const bySlot = contextualPromptsBySlot(
      contextWith({ kind: "concurrency_saturation", severity: "warn" }),
      Date.now()
    );

    expect(bySlot.watch[0]?.prompt).toBe(
      "Concurrency is saturated right now. Watch it and tell me when the backlog drains."
    );
  });
});
