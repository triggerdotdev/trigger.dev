import { describe, expect, it } from "vitest";
import { resolveAlertDraftPrefill } from "~/v3/services/alerts/createAlertFromDraft.server";
import { v3AlertCreatePath, type AlertDraftPrefillParams, v3AlertPath } from "~/utils/pathBuilder";
import { ChatRequestSchema as RequestSchema } from "~/v3/services/alerts/alertDraft";
import { notifyLabel, extractAlertId } from "./CreationFlow";
import {
  capabilityChips,
  effectiveSignals,
  EXPIRY_CHIPS,
  expiryFromDate,
  prefillToAnswers,
  resolveCapability,
  scopeChipsFor,
  searchParamsToAnswers,
  STEP_ORDER,
  stripCreateSearchParams,
} from "./flow-state";
import type { FlowAnswers } from "./flow-state";

const org = { slug: "org" };
const project = { slug: "project" };
const environment = { slug: "dev" };

describe("prefillToAnswers", () => {
  it("resolves capability into area and what", () => {
    const answers = prefillToAnswers({
      capability: "queue.depth",
      scope: "queue",
      scopeValue: "my-q",
    });
    expect(answers.area).toBe("queues");
    expect(answers.what).toBe("queue.depth");
    expect(answers.scope).toBe("queue");
    expect(answers.scopeValue).toBe("my-q");
  });

  it("fails if scope param is ignored", () => {
    const withScope = prefillToAnswers({ capability: "queue.depth", scope: "queue" });
    const without = prefillToAnswers({ capability: "queue.depth" });
    expect(withScope.scope).toBe("queue");
    expect(without.scope).toBeUndefined();
  });

  it("returns empty answers for unknown capability", () => {
    const answers = prefillToAnswers({ capability: "nonexistent.metric" });
    expect(answers.area).toBeUndefined();
    expect(answers.what).toBeUndefined();
  });
});

describe("manual form submit body parses ChatFormSchema", () => {
  function buildBody(answers: FlowAnswers) {
    const cap = resolveCapability(answers.what);
    const kind = cap?.allowedKinds[0] ?? "threshold";
    const notifierIds = (answers.notifiers ?? []).filter((n) => n !== "chat");
    return {
      organizationId: "org_123",
      projectId: "proj_456",
      environmentId: "env_789",
      chatNotifier: (answers.notifiers ?? []).includes("chat") ? ("on" as const) : undefined,
      chatId: "chat_abc",
      form: {
        capabilityKey: answers.what,
        scopeType: answers.scope,
        scopeValue: answers.scopeValue,
        conditionKind: kind,
        operator: kind === "threshold" ? (">" as const) : undefined,
        value: answers.condition ? Number(answers.condition) : undefined,
        windowMinutes: kind === "threshold" ? (answers.windowMinutes ?? 5) : undefined,
        quietWindowMinutes:
          kind === "absence" && answers.condition ? Number(answers.condition) : undefined,
        notifierChannelIds: notifierIds,
      },
    };
  }

  it("parses a complete threshold alert body", () => {
    const body = buildBody({
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
      windowMinutes: 5,
      notifiers: ["chat"],
    });
    expect(RequestSchema.safeParse(body).success).toBe(true);
  });

  it("fails if environmentId is dropped", () => {
    const body = buildBody({
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
      windowMinutes: 5,
      notifiers: ["chat"],
    });
    const { environmentId: _, ...noEnv } = body;
    expect(RequestSchema.safeParse(noEnv).success).toBe(false);
  });
});

describe("v3AlertCreatePath round-trip", () => {
  it("builds the alerts path with create=1 and no prefill", () => {
    const path = v3AlertCreatePath(org, project, environment);
    const url = new URL(path, "http://test");
    expect(url.pathname).toBe("/orgs/org/projects/project/env/dev/alerts");
    expect(url.searchParams.get("create")).toBe("1");
  });

  it("encodes capability, scope, and scopeValue", () => {
    const path = v3AlertCreatePath(org, project, environment, {
      capability: "queue.depth",
      scope: "queue",
      scopeValue: "my-queue",
    });
    const url = new URL(path, "http://test");
    expect(url.searchParams.get("create")).toBe("1");
    expect(url.searchParams.get("capability")).toBe("queue.depth");
    expect(url.searchParams.get("scope")).toBe("queue");
    expect(url.searchParams.get("scopeValue")).toBe("my-queue");
  });

  it("round-trips through resolveAlertDraftPrefill", () => {
    const path = v3AlertCreatePath(org, project, environment, {
      capability: "runs.failure_rate",
      scope: "task",
      scopeValue: "my-task",
    });
    const url = new URL(path, "http://test");
    const prefill = resolveAlertDraftPrefill({
      capability: url.searchParams.get("capability") ?? undefined,
      scope: (url.searchParams.get("scope") as "task") ?? undefined,
      scopeValue: url.searchParams.get("scopeValue") ?? undefined,
    });
    expect(prefill).toEqual({
      capabilityKey: "runs.failure_rate",
      scope: { type: "task", taskIdentifier: "my-task" },
    });
  });

  it("round-trips prefill params through prefillToAnswers", () => {
    const params: AlertDraftPrefillParams = {
      capability: "queue.depth",
      scope: "queue",
      scopeValue: "my-q",
    };
    const path = v3AlertCreatePath(org, project, environment, params);
    const url = new URL(path, "http://test");
    const answers = prefillToAnswers({
      capability: url.searchParams.get("capability") ?? undefined,
      scope: url.searchParams.get("scope") ?? undefined,
      scopeValue: url.searchParams.get("scopeValue") ?? undefined,
    });
    expect(answers.area).toBe("queues");
    expect(answers.what).toBe("queue.depth");
    expect(answers.scope).toBe("queue");
    expect(answers.scopeValue).toBe("my-q");
  });
});

describe("notifyLabel", () => {
  it("shows channel names instead of raw ids", () => {
    const channels = [
      { id: "ch_1", name: "Slack #alerts", type: "slack" },
      { id: "ch_2", name: "Email ops", type: "email" },
    ];
    const answers: FlowAnswers = { notifiers: ["chat", "ch_1", "ch_2"] };
    const label = notifyLabel(answers, channels);
    expect(label).toBe("this chat, Slack #alerts, Email ops");
    expect(label).not.toContain("ch_1");
    expect(label).not.toContain("ch_2");
  });

  it("returns None when no notifiers selected", () => {
    expect(notifyLabel({}, [])).toBe("None");
    expect(notifyLabel({ notifiers: [] }, [])).toBe("None");
  });
});

describe("ChatRequestSchema rejects chatNotifier without chatId", () => {
  it("rejects chatNotifier:on without chatId", () => {
    const body = {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      chatNotifier: "on" as const,
      form: {
        capabilityKey: "queue.depth",
        scopeType: "all" as const,
        conditionKind: "threshold" as const,
        operator: ">" as const,
        value: 100,
        windowMinutes: 5,
        notifierChannelIds: [],
      },
    };
    expect(RequestSchema.safeParse(body).success).toBe(false);
  });

  it("accepts chatNotifier:on with chatId", () => {
    const body = {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      chatNotifier: "on" as const,
      chatId: "chat_abc",
      form: {
        capabilityKey: "queue.depth",
        scopeType: "all" as const,
        conditionKind: "threshold" as const,
        operator: ">" as const,
        value: 100,
        windowMinutes: 5,
        notifierChannelIds: [],
      },
    };
    expect(RequestSchema.safeParse(body).success).toBe(true);
  });

  it("notifier default without chatId is empty", () => {
    const answers = prefillToAnswers({ capability: "queue.depth" });
    expect(answers.notifiers).toBeUndefined();
  });
});

describe("simplified wizard options", () => {
  // Mutation: passing curatedOnly to listCapabilities again drops these.
  it("the what step lists non-curated capabilities with registry labels", () => {
    const all = capabilityChips("runs");
    const match = all.find((c) => c.value === "runs.failure_rate");
    expect(match).toBeDefined();
    expect(match!.label).not.toBe("runs.failure_rate");
  });

  // Mutation: adding a preset back to EXPIRY_CHIPS.
  it("expiry presets are no expiry, 24 hours and custom", () => {
    expect(EXPIRY_CHIPS.map((c) => c.value)).toEqual(["none", "24h", "custom"]);
  });

  it("custom expiry is stored as the exact ISO timestamp", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(expiryFromDate(new Date("2026-01-02T10:30:00Z"), now)).toBe("2026-01-02T10:30:00.000Z");
    expect(expiryFromDate(new Date("2025-12-31T10:30:00Z"), now)).toBeUndefined();
    expect(expiryFromDate(undefined, now)).toBeUndefined();
  });

  // Mutation: re-adding the behavior step.
  it("STEP_ORDER has no behavior step", () => {
    expect(STEP_ORDER).toEqual([
      "area",
      "what",
      "condition",
      "scope",
      "environments",
      "notifiers",
      "name",
    ]);
  });

  // Mutation: no longer filtering queuePattern from the scope options.
  it("scope options exclude queuePattern", () => {
    expect(scopeChipsFor("queue.depth").map((c) => c.value)).toEqual(["all", "queue"]);
  });
});

describe("in-place prefill yields answers with first visible step = condition", () => {
  it("queue prefill sets area/what/scope and lands on condition", () => {
    const answers = prefillToAnswers({
      capability: "queue.depth",
      scope: "queue",
      scopeValue: "my-q",
    });
    expect(answers.area).toBe("queues");
    expect(answers.what).toBe("queue.depth");
    expect(answers.scope).toBe("queue");
    expect(answers.scopeValue).toBe("my-q");

    function firstMissingStep(a: FlowAnswers): string | undefined {
      for (const key of STEP_ORDER) {
        if (key === "notifiers") continue;
        if (a[key] === undefined) return key;
      }
      return undefined;
    }
    expect(firstMissingStep(answers)).toBe("condition");
  });

  it("fails if prefill is ignored (empty answers)", () => {
    const answers = prefillToAnswers({});
    expect(answers.area).toBeUndefined();
  });
});

describe("stripCreateSearchParams", () => {
  it("removes create, capability, scope, scopeValue from URL params", () => {
    const params = new URLSearchParams(
      "create=1&capability=queue.depth&scope=queue&scopeValue=my-q&filter=active"
    );
    const stripped = stripCreateSearchParams(params);
    expect(stripped.has("create")).toBe(false);
    expect(stripped.has("capability")).toBe(false);
    expect(stripped.has("scope")).toBe(false);
    expect(stripped.has("scopeValue")).toBe(false);
    expect(stripped.get("filter")).toBe("active");
  });

  it("fails if strip is removed (params survive)", () => {
    const params = new URLSearchParams("create=1&capability=queue.depth");
    const stripped = stripCreateSearchParams(params);
    expect(stripped.has("create")).toBe(false);
  });
});

describe("in-place queue prefill produces a valid create payload", () => {
  it("rejects if chat is the only notifier with no chatId", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "queue",
      scopeValue: "worker-queue",
      condition: "100",
      windowMinutes: 5,
      notifiers: ["chat"],
    };
    const cap = resolveCapability(answers.what);
    const kind = cap?.allowedKinds[0] ?? "threshold";
    const notifierIds = (answers.notifiers ?? []).filter((n) => n !== "chat");
    const body = {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      chatNotifier: undefined,
      chatId: undefined,
      form: {
        capabilityKey: answers.what,
        scopeType: answers.scope,
        scopeValue: answers.scopeValue,
        conditionKind: kind,
        operator: kind === "threshold" ? (">" as const) : undefined,
        value: answers.condition ? Number(answers.condition) : undefined,
        windowMinutes: kind === "threshold" ? (answers.windowMinutes ?? 5) : undefined,
        notifierChannelIds: notifierIds,
      },
    };
    const result = RequestSchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it("succeeds with chatNotifier and chatId when session is ready", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "queue",
      scopeValue: "worker-queue",
      condition: "100",
      windowMinutes: 5,
      notifiers: ["chat"],
    };
    const cap = resolveCapability(answers.what);
    const kind = cap?.allowedKinds[0] ?? "threshold";
    const body = {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      chatNotifier: "on" as const,
      chatId: "chat_session_123",
      form: {
        capabilityKey: answers.what,
        scopeType: answers.scope,
        scopeValue: answers.scopeValue,
        conditionKind: kind,
        operator: kind === "threshold" ? (">" as const) : undefined,
        value: answers.condition ? Number(answers.condition) : undefined,
        windowMinutes: kind === "threshold" ? (answers.windowMinutes ?? 5) : undefined,
        notifierChannelIds: [],
      },
    };
    expect(RequestSchema.safeParse(body).success).toBe(true);
  });

  it("succeeds with a channel notifier and no chat (in-place without session)", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "queue",
      scopeValue: "worker-queue",
      condition: "100",
      windowMinutes: 5,
      notifiers: ["ch_webhook_1"],
    };
    const cap = resolveCapability(answers.what);
    const kind = cap?.allowedKinds[0] ?? "threshold";
    const notifierIds = (answers.notifiers ?? []).filter((n) => n !== "chat");
    const body = {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      form: {
        capabilityKey: answers.what,
        scopeType: answers.scope,
        scopeValue: answers.scopeValue,
        conditionKind: kind,
        operator: kind === "threshold" ? (">" as const) : undefined,
        value: answers.condition ? Number(answers.condition) : undefined,
        windowMinutes: kind === "threshold" ? (answers.windowMinutes ?? 5) : undefined,
        notifierChannelIds: notifierIds,
      },
    };
    expect(RequestSchema.safeParse(body).success).toBe(true);
  });
});

describe("queue scopeValue accepts queue identifiers", () => {
  it("validates worker-queue as a valid queue scopeValue", () => {
    const body = {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      chatNotifier: "on" as const,
      chatId: "chat_abc",
      form: {
        capabilityKey: "queue.depth",
        scopeType: "queue" as const,
        scopeValue: "worker-queue",
        conditionKind: "threshold" as const,
        operator: ">" as const,
        value: 100,
        windowMinutes: 5,
        notifierChannelIds: [],
      },
    };
    expect(RequestSchema.safeParse(body).success).toBe(true);
  });

  it("rejects empty queue scopeValue", () => {
    const body = {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      chatNotifier: "on" as const,
      chatId: "chat_abc",
      form: {
        capabilityKey: "queue.depth",
        scopeType: "queue" as const,
        scopeValue: "",
        conditionKind: "threshold" as const,
        operator: ">" as const,
        value: 100,
        windowMinutes: 5,
        notifierChannelIds: [],
      },
    };
    expect(RequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("deep-link prefill survives URL strip", () => {
  it("prefillToAnswers is not overwritten by draftFromSearch with empty params", () => {
    const prefill = prefillToAnswers({
      capability: "queue.depth",
      scope: "queue",
      scopeValue: "test-queue",
    });
    expect(prefill.area).toBe("queues");
    expect(prefill.what).toBe("queue.depth");
    expect(prefill.scope).toBe("queue");
    expect(prefill.scopeValue).toBe("test-queue");

    const emptyDraft = searchParamsToAnswers({});
    expect(emptyDraft.area).toBeUndefined();
    expect(emptyDraft.what).toBeUndefined();
  });
});

describe("createdAlertId flows from create response to SuccessCard link", () => {
  it("extractAlertId returns the id from {alertId}", () => {
    expect(extractAlertId({ alertId: "alert_abc" })).toBe("alert_abc");
  });

  it("extractAlertId returns undefined for true/false/void", () => {
    expect(extractAlertId(true)).toBeUndefined();
    expect(extractAlertId(false)).toBeUndefined();
    expect(extractAlertId(undefined)).toBeUndefined();
  });

  it("SuccessCard link href matches v3AlertPath", () => {
    const alertId = "alert_abc";
    const path = v3AlertPath(org, project, environment, alertId);
    expect(path).toContain(alertId);
    expect(path).toBe("/orgs/org/projects/project/env/dev/alerts/alert_abc");
  });

  it("fails if alertId is dropped from the response", () => {
    const result = extractAlertId({ alertId: "alert_abc" });
    expect(result).toBe("alert_abc");
  });
});

describe("effectiveSignals", () => {
  // Mutation: dropping the implicit approaching rule leaves limits.queue unwatched.
  it.each([
    [
      ["limits.api", "limits.queue"],
      ["approaching", "limited"],
    ],
    [["limits.api", "limits.webhooks.waiters"], ["limited"]],
  ])("limits.all %j with signals [limited] watches %j", (components, expected) => {
    expect(effectiveSignals({ what: "limits.all", components, signals: ["limited"] })).toEqual(
      expected
    );
  });
});
