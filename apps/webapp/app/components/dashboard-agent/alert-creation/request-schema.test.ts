import { describe, expect, it } from "vitest";
import { ChatRequestSchema as RequestSchema } from "~/v3/services/alerts/alertDraft";
import { resolveCapability } from "./flow-state";
import type { FlowAnswers } from "./flow-state";

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

describe("RequestSchema (ChatFormSchema refinements)", () => {
  it("accepts chat-only notifier", () => {
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

  it("accepts channel IDs", () => {
    const body = buildBody({
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "50",
      windowMinutes: 5,
      notifiers: ["ch_slack_1"],
    });
    expect(RequestSchema.safeParse(body).success).toBe(true);
  });

  it("rejects flat body (no form nesting)", () => {
    const flat = {
      organizationId: "org_123",
      projectId: "proj_456",
      environmentId: "env_789",
      capabilityKey: "queue.depth",
      scopeType: "all",
      conditionKind: "threshold",
      operator: ">",
      value: 100,
      windowMinutes: 5,
      chatNotifier: "on",
      channelIds: [],
    };
    expect(RequestSchema.safeParse(flat).success).toBe(false);
  });

  it("rejects zero notifiers when chatNotifier is not on", () => {
    const body = buildBody({
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
      windowMinutes: 5,
      notifiers: [],
    });
    expect(RequestSchema.safeParse(body).success).toBe(false);
  });

  it("rejects threshold without windowMinutes", () => {
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
        notifierChannelIds: [],
      },
    };
    expect(RequestSchema.safeParse(body).success).toBe(false);
  });

  it("rejects non-all scope without scopeValue", () => {
    const body = {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      chatNotifier: "on" as const,
      form: {
        capabilityKey: "queue.depth",
        scopeType: "queue" as const,
        conditionKind: "threshold" as const,
        operator: ">" as const,
        value: 100,
        windowMinutes: 5,
        notifierChannelIds: [],
      },
    };
    expect(RequestSchema.safeParse(body).success).toBe(false);
  });

  it("accepts non-all scope with scopeValue", () => {
    const body = {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      chatNotifier: "on" as const,
      chatId: "chat_1",
      form: {
        capabilityKey: "queue.depth",
        scopeType: "queue" as const,
        scopeValue: "my-queue",
        conditionKind: "threshold" as const,
        operator: ">" as const,
        value: 100,
        windowMinutes: 5,
        notifierChannelIds: [],
      },
    };
    expect(RequestSchema.safeParse(body).success).toBe(true);
  });

  it("rejects absence without quietWindowMinutes", () => {
    const body = {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      chatNotifier: "on" as const,
      form: {
        capabilityKey: "runs.created",
        scopeType: "all" as const,
        conditionKind: "absence" as const,
        notifierChannelIds: [],
      },
    };
    expect(RequestSchema.safeParse(body).success).toBe(false);
  });
});
