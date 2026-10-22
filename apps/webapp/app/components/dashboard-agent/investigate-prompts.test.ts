import { describe, expect, it } from "vitest";
import {
  alertInvestigatePrompt,
  createAlertPrompt,
  type AlertInvestigateContext,
} from "./investigate-prompts";

const BASE_CONTEXT: AlertInvestigateContext = {
  alertId: "alert_123",
  capabilityKey: "queue.depth",
  environmentId: "env_456",
  scope: { type: "queue", queue: "worker-1" },
  name: "Queue depth high",
  capabilityTitle: "Queue depth",
  conditionSummary: "> 100 over 5m",
  windowSec: 300,
  latestRaisedEventFacts: { value: 150, threshold: 100 },
};

describe("alertInvestigatePrompt", () => {
  it("includes the alertId and capabilityKey in the prompt", () => {
    const prompt = alertInvestigatePrompt(BASE_CONTEXT);

    expect(prompt).toContain(BASE_CONTEXT.alertId);
    expect(prompt).toContain(BASE_CONTEXT.capabilityKey);
  });

  it("includes the environmentId, scope and frozen facts", () => {
    const prompt = alertInvestigatePrompt(BASE_CONTEXT);

    expect(prompt).toContain(BASE_CONTEXT.environmentId);
    expect(prompt).toContain("worker-1");
    expect(prompt).toContain("150");
  });

  it("states the issue-not-run interpretation rule", () => {
    const prompt = alertInvestigatePrompt(BASE_CONTEXT);

    expect(prompt).toMatch(/never a single run/i);
  });
});

describe("createAlertPrompt", () => {
  it("names the environment and instructs the agent to use its tools", () => {
    const prompt = createAlertPrompt("staging");

    expect(prompt).toContain("staging");
    expect(prompt).toMatch(/monitoring\/alert tools/i);
  });
});
