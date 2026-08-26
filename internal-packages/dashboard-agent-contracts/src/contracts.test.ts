import { describe, expect, it } from "vitest";
import { evidenceSchema } from "./evidence.js";
import { agentIntentSchema, isExecutableIntent } from "./intent.js";
import {
  agentPageSchema,
  agentPageSignalSchema,
  dashboardAgentClientDataSchema,
} from "./page-context.js";
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

  it("parses ask and watch", () => {
    expect(agentIntentSchema.safeParse({ kind: "ask", prompt: "why?" }).success).toBe(true);
    expect(
      agentIntentSchema.safeParse({
        kind: "watch",
        spec: {
          kind: "backlog_drain",
          queue: "email-sends",
          checkEveryMinutes: 5,
          maxHours: 2,
          note: "waiting for the backlog",
        },
      }).success
    ).toBe(true);
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

  it("round-trips concurrency_saturation without its identity fields", () => {
    const signal = { kind: "concurrency_saturation" as const, severity: "warn" as const };
    expect(agentPageSignalSchema.parse(signal)).toEqual(signal);
  });

  it("round-trips concurrency_saturation with its identity fields", () => {
    const signal = {
      kind: "concurrency_saturation" as const,
      severity: "crit" as const,
      scope: "queue" as const,
      queueName: "black-friday",
      limit: 10,
      current: 12,
    };
    expect(agentPageSignalSchema.parse(signal)).toEqual(signal);
  });

  it("parses the list page kinds, which carry no identity of their own", () => {
    for (const kind of [
      "runs",
      "errors",
      "queues",
      "deployments",
      "tasks",
      "batches",
      "test",
      "alerts",
      "apikeys",
      "envvars",
      "concurrency",
      "regions",
      "settings",
      "waitpoints",
      "bulkactions",
      "branches",
      "logs",
      "limits",
      "query",
      "dashboards",
      "agents",
      "playground",
      "prompts",
      "models",
      "sessions",
    ] as const) {
      expect(agentPageSchema.safeParse({ kind }).success, kind).toBe(true);
    }
  });

  it("keeps every section field optional, so a thin loader still classifies", () => {
    expect(agentPageSchema.safeParse({ kind: "sessions", sessionId: "sess_1" }).success).toBe(true);
    expect(agentPageSchema.safeParse({ kind: "waitpoints", tokenId: "wp_1" }).success).toBe(true);
    expect(agentPageSchema.safeParse({ kind: "prompts", slug: "summarise" }).success).toBe(true);
  });

  it("requires the identity a detail kind is named after", () => {
    expect(agentPageSchema.safeParse({ kind: "task" }).success).toBe(false);
    expect(agentPageSchema.safeParse({ kind: "task", taskId: "process-order" }).success).toBe(true);

    expect(agentPageSchema.safeParse({ kind: "batch" }).success).toBe(false);
    expect(agentPageSchema.safeParse({ kind: "batch", batchId: "batch_1" }).success).toBe(true);

    expect(agentPageSchema.safeParse({ kind: "schedule", scheduleId: "sched_1" }).success).toBe(
      false
    );
    expect(
      agentPageSchema.safeParse({ kind: "schedule", scheduleId: "sched_1", taskId: "nightly" })
        .success
    ).toBe(true);
  });

  it("keeps the deployment status optional", () => {
    expect(agentPageSchema.parse({ kind: "deployment", version: "20260803.1" }).kind).toBe(
      "deployment"
    );
    const parsed = agentPageSchema.parse({
      kind: "deployment",
      version: "20260803.1",
      status: "Failed",
    });
    expect(parsed).toMatchObject({ status: "Failed" });
  });

  it("rejects an unknown page kind", () => {
    expect(
      dashboardAgentClientDataSchema.safeParse({
        userId: "user_1",
        organizationId: "org_1",
        pageContext: { page: { kind: "sprockets" }, signals: [] },
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
