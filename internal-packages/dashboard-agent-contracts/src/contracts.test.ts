import { describe, expect, it } from "vitest";
import { evidenceSchema } from "./evidence.js";
import { agentIntentSchema, isExecutableIntent } from "./intent.js";
import { dashboardAgentClientDataSchema } from "./page-context.js";
import { SUGGESTED_PROMPT_CAP, suggestedPromptSchema } from "./suggested-prompts.js";
import { formatTriggerUri } from "./trigger-uri.js";

const proj = "proj_abc123";
const env = "cm5x9k2h40000abcd";
const runUri = formatTriggerUri({
  kind: "run",
  projectRef: proj,
  environmentId: env,
  runId: "run_1",
});

describe("evidence", () => {
  it("accepts a uri-backed citation", () => {
    const parsed = evidenceSchema.parse({
      kind: "run",
      uri: runUri,
      label: "run_1 failed",
      excerpt: "TypeError: boom",
    });
    expect(parsed.uri).toBe(runUri);
  });

  it("rejects a non-uri reference", () => {
    expect(evidenceSchema.safeParse({ kind: "run", uri: "run_1", label: "run_1" }).success).toBe(
      false
    );
  });

  it("rejects a kind outside the uri resource kinds", () => {
    expect(evidenceSchema.safeParse({ kind: "logs", uri: runUri, label: "logs" }).success).toBe(
      false
    );
  });
});

describe("intents", () => {
  it("parses navigate with filters", () => {
    const parsed = agentIntentSchema.parse({
      kind: "navigate",
      target: runUri,
      filters: { statuses: ["FAILED"], period: "24h" },
    });
    expect(parsed.kind).toBe("navigate");
    expect(isExecutableIntent(parsed)).toBe(true);
  });

  it("parses ask", () => {
    expect(agentIntentSchema.safeParse({ kind: "ask", prompt: "why?" }).success).toBe(true);
  });

  it("keeps propose_fix in the wire format but marks it non-executable", () => {
    const parsed = agentIntentSchema.parse({ kind: "propose_fix", investigationId: "inv_1" });
    expect(parsed.kind).toBe("propose_fix");
    expect(isExecutableIntent(parsed)).toBe(false);
  });

  it("rejects an unknown intent kind", () => {
    expect(agentIntentSchema.safeParse({ kind: "delete_everything" }).success).toBe(false);
  });
});

describe("client data", () => {
  it("parses the pre-existing shape (all new fields optional)", () => {
    const parsed = dashboardAgentClientDataSchema.parse({
      userId: "user_1",
      organizationId: "org_1",
      projectId: "project_1",
      environmentId: "env_1",
      currentPage: "/orgs/x/projects/y/env/dev/runs",
    });
    expect(parsed.pageContext).toBeUndefined();
  });

  it("parses page context when present", () => {
    const parsed = dashboardAgentClientDataSchema.parse({
      userId: "user_1",
      organizationId: "org_1",
      pageContext: {
        page: { kind: "run", runId: "run_1", status: "FAILED", taskId: "process-order" },
        signals: [
          { kind: "fresh_failure", runId: "run_1", failedAt: "2026-07-27T10:00:00.000Z" },
          { kind: "concurrency_saturation", severity: "crit" },
        ],
      },
    });
    expect(parsed.pageContext?.signals).toHaveLength(2);
  });

  it("rejects an unknown page kind", () => {
    expect(
      dashboardAgentClientDataSchema.safeParse({
        userId: "user_1",
        organizationId: "org_1",
        pageContext: { page: { kind: "schedules" }, signals: [] },
      }).success
    ).toBe(false);
  });
});

describe("suggested prompts", () => {
  it("has a shape and a cap", () => {
    expect(
      suggestedPromptSchema.safeParse({
        id: "why-failed",
        label: "Why did this fail?",
        prompt: "Why did this run fail?",
        source: "contextual",
      }).success
    ).toBe(true);
    expect(SUGGESTED_PROMPT_CAP).toBe(5);
  });
});
