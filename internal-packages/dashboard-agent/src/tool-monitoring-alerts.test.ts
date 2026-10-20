import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMonitoringAlertTools, _validateDraftPatch } from "./tool-monitoring-alerts";
import { createApiClient } from "./tool-api-client";
import {
  createMonitoringAlertInputSchema,
  DASHBOARD_AGENT_MONITORING_ALERT_TOOL_NAMES,
  DASHBOARD_AGENT_SYSTEM_PROMPT,
  DASHBOARD_AGENT_WATCH_PROMPT,
  dashboardAgentToolSchemas,
  describeAlertCapabilitiesInputSchema,
  updateAlertDraftSchema,
} from "./tool-schemas";
import {
  alertDraftPatchSchema,
  type AlertCreationDraft,
} from "@internal/dashboard-agent-contracts";
import { alertDraftContextText, toolSchemasFor, withAlertDraftContext } from "./prompt-assembly";
import { clientDataSchema, scopeTurnTools } from "./agent-runtime";
import { buildDashboardAgentTools } from "./tools";
import { behaviorSchema, getCapability } from "@internal/alert-contracts";

describe("creation turn tools on the agent run", () => {
  const base = { userActorToken: "uat", apiOrigin: "https://api.example.com", chatId: "chat_1" };

  // Mutation: gating buildMonitoringAlertTools on watchEnabled alone drops the draft tool.
  it.each([false, true])("offers update_alert_draft and not create (watches %s)", (watch) => {
    const clientData = { ...base, watchEnabled: watch, toolScope: "alert_creation" };
    const tools = scopeTurnTools(buildDashboardAgentTools(clientData), clientData);
    expect(tools).toHaveProperty("update_alert_draft");
    expect(tools).toHaveProperty("describe_alert_capabilities");
    expect(tools).not.toHaveProperty("create_monitoring_alert");
    expect(tools).not.toHaveProperty("schedule_watch");
    expect(Object.keys(tools)).toEqual(
      Object.keys(toolSchemasFor("assistant", { watchEnabled: watch, scope: "alert_creation" }))
    );
  });

  it("leaves a normal turn's tools alone", () => {
    const clientData = { ...base, watchEnabled: true };
    const tools = buildDashboardAgentTools(clientData);
    expect(scopeTurnTools(tools, clientData)).toBe(tools);
  });

  // Mutation: dropping the no-unbacked-claim line fails this.
  it("forbids claiming a value is set without the tool call", () => {
    expect(DASHBOARD_AGENT_SYSTEM_PROMPT).toContain(
      "never say a value is set or updated unless you called update_alert_draft for it in this turn"
    );
  });

  it("points the user at Continue, not an invented control", () => {
    expect(DASHBOARD_AGENT_SYSTEM_PROMPT).toContain(
      "after update_alert_draft succeeds, tell the user to press Continue"
    );
    expect(DASHBOARD_AGENT_SYSTEM_PROMPT).not.toContain("Done/Create");
  });

  // Mutation: dropping the error-patch line from the prompt fails this.
  it("tells the agent to patch an identified error instead of talking cadence", () => {
    expect(DASHBOARD_AGENT_SYSTEM_PROMPT).toContain(
      'once a specific error is identified, patch area "errors", what "errors.occurred_again"'
    );
    expect(DASHBOARD_AGENT_SYSTEM_PROMPT).toContain("Never offer check cadence or defaults");
  });

  // Mutation: dropping the recommended-values line from the prompt fails this.
  it("patches recommended values instead of offering to apply them", () => {
    expect(DASHBOARD_AGENT_SYSTEM_PROMPT).toContain(
      "asked for recommended values, answer briefly and in the same turn patch what and condition.params with describe_alert_capabilities defaults; never ask whether to apply them"
    );
    expect(DASHBOARD_AGENT_SYSTEM_PROMPT).toContain("Never offer check cadence or defaults");
  });

  // Mutation: removing errorGroup or the id fields from the patch schema fails this.
  it("accepts an error group in a draft patch", async () => {
    const patch = {
      area: "errors",
      what: "errors.occurred_again",
      scope: {
        type: "errorGroup",
        errorId: "error_744b4159",
        taskIdentifier: "sync-inventory",
        fingerprint: "744b4159",
      },
    };
    expect(alertDraftPatchSchema.parse(patch)).toEqual(patch);
    const result = await run("update_alert_draft", { patch });
    expect(result.ok).toBe(true);
    const missing = await run("update_alert_draft", {
      patch: { what: "errors.occurred_again", scope: { type: "errorGroup" } },
    });
    expect(missing.ok).toBe(false);
  });
});

const ORIGIN = "https://api.example.com";

const CTX = {
  userActorToken: "uat",
  apiOrigin: ORIGIN,
  chatId: "chat_1",
};

function tools() {
  return buildMonitoringAlertTools({ ctx: CTX as any, client: createApiClient(CTX as any) });
}

const run = (name: string, input: any = {}) =>
  (tools()[name] as any).execute(input, {} as any) as Promise<Record<string, any>>;

afterEach(() => vi.unstubAllGlobals());

describe("monitoring alert tools time out instead of hanging", () => {
  it("surfaces a timeout error when the API never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("The operation was aborted."))
            );
          })
      )
    );

    const result = await run("describe_alert_capabilities");

    expect(result.error).toContain("Couldn't reach the monitoring alerts API");
  }, 15_000);
});

describe("describe_alert_capabilities area enum", () => {
  it("lists queues/runs/health/errors", () => {
    const areaField = describeAlertCapabilitiesInputSchema.shape.area.unwrap();
    expect(areaField.options).toEqual(["queues", "runs", "health", "errors"]);
  });
});

describe("create_monitoring_alert scope type enum", () => {
  it("accepts the errorGroup scope and keeps its fingerprint", () => {
    const scopeType = createMonitoringAlertInputSchema.shape.scope.unwrap().shape.type;
    expect(scopeType.options).toEqual(["queue", "queuePattern", "task", "all", "errorGroup"]);
    const parsed = createMonitoringAlertInputSchema.parse({
      capabilityKey: "errors.occurred_again",
      scope: { type: "errorGroup", taskIdentifier: "t", fingerprint: "f" },
      condition: { kind: "occurrence" },
    });
    expect(parsed.scope).toEqual({ type: "errorGroup", taskIdentifier: "t", fingerprint: "f" });
  });
});

describe("create_monitoring_alert validation feedback", () => {
  it("returns the failing field path for a timezone-less expiresAt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}");
        const parsed = behaviorSchema.safeParse(body.behavior);
        if (parsed.success) {
          return new Response(JSON.stringify({ alert: { id: "alert_1" } }), { status: 200 });
        }
        const issues = parsed.error.issues.map((i) => ({ ...i, path: ["behavior", ...i.path] }));
        return new Response(JSON.stringify({ error: "Invalid request", issues }), { status: 400 });
      })
    );

    const result = await run("create_monitoring_alert", {
      capabilityKey: "queue.depth",
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      behavior: { expiresAt: "2099-12-01T10:00:00" },
    });

    expect(result.error).toContain("behavior.expiresAt");
  });
});

describe("create_monitoring_alert errorGroup scope", () => {
  const errorGroupInput = (fingerprint: string, taskIdentifier?: string) => ({
    capabilityKey: "errors.occurred_again",
    scope: { type: "errorGroup", fingerprint, ...(taskIdentifier ? { taskIdentifier } : {}) },
    condition: { kind: "occurrence" },
  });

  it("rejects a fingerprint-only scope without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await run("create_monitoring_alert", errorGroupInput("f"));

    expect(result.error).toContain("taskIdentifier and fingerprint");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the bare fingerprint for an error_ id", async () => {
    let body: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        body = init?.body ? JSON.parse(init.body) : undefined;
        return new Response(JSON.stringify({ alert: { id: "alert_1" } }), { status: 200 });
      })
    );

    await run("create_monitoring_alert", errorGroupInput("error_abc", "t"));

    expect(body.scope).toEqual({ type: "errorGroup", taskIdentifier: "t", fingerprint: "abc" });
  });
});

describe("create_monitoring_alert params pass-through", () => {
  it("fails when params are dropped before the server call", async () => {
    let body: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        body = init?.body ? JSON.parse(init.body) : undefined;
        return new Response(JSON.stringify({ alert: { id: "alert_1" } }), { status: 200 });
      })
    );

    await run("create_monitoring_alert", {
      capabilityKey: "health.all",
      condition: { kind: "state", stateKey: "flow", params: { schedulingDelayMs: 5000 } },
    });

    expect(body.condition.params).toEqual({ schedulingDelayMs: 5000 });
  });

  it("only carries params on a state condition", () => {
    const result = createMonitoringAlertInputSchema.safeParse({
      capabilityKey: "queue.depth",
      condition: {
        kind: "threshold",
        operator: ">",
        value: 10,
        windowSec: 300,
        params: { foo: 1 },
      },
    });

    expect(result.success).toBe(true);
    expect((result as any).data.condition.params).toBeUndefined();
  });
});

describe("update_alert_draft", () => {
  it("fails when an unknown capability key is accepted", async () => {
    const result = await run("update_alert_draft", {
      patch: { what: "nonexistent.capability" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("unknown capability key"));
  });

  it("fails when a param above max is accepted", async () => {
    const result = await run("update_alert_draft", {
      patch: {
        what: "health.execution",
        condition: { kind: "state", params: { failureRatePct: 999 } },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("above max"));
  });

  it("fails when the tool persists (calls create) instead of returning the patch", async () => {
    let fetched = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetched = true;
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    const result = await run("update_alert_draft", {
      patch: { what: "queue.depth", area: "queues" },
    });

    expect(fetched).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.patch).toBeDefined();
  });

  it("fails when the tool is missing from the alert-creation scope", () => {
    expect(DASHBOARD_AGENT_MONITORING_ALERT_TOOL_NAMES).toContain("update_alert_draft");
    expect(dashboardAgentToolSchemas).toHaveProperty("update_alert_draft");
    const toolSet = tools();
    expect(toolSet).toHaveProperty("update_alert_draft");
  });

  it("fails when alert_creation scope includes create_monitoring_alert", () => {
    const scopeTools = toolSchemasFor("assistant", {
      watchEnabled: true,
      scope: "alert_creation",
    });
    expect(scopeTools).not.toHaveProperty("create_monitoring_alert");
    expect(scopeTools).not.toHaveProperty("resolve_monitoring_alert");
    expect(scopeTools).toHaveProperty("update_alert_draft");
    expect(scopeTools).toHaveProperty("describe_alert_capabilities");
  });

  it("returns the normalised patch on valid input", async () => {
    const result = await run("update_alert_draft", {
      patch: { area: "queues", what: "queue.depth" },
      reason: "Watching queue depth",
    });
    expect(result.ok).toBe(true);
    expect(result.patch.area).toBe("queues");
    expect(result.reason).toBe("Watching queue depth");
  });
});

describe("update_alert_draft lenient input", () => {
  const parseInput = (raw: unknown) =>
    (tools().update_alert_draft as any).inputSchema.safeParse(raw) as {
      success: boolean;
      data?: any;
      error?: { issues: Array<{ path: unknown[] }> };
    };

  // Mutation: dropping the flat-form or params-string preprocess fails this.
  it("accepts the flat form with params as a JSON string", async () => {
    const parsed = parseInput({
      area: "health",
      what: "health.execution",
      params: '{"failureRatePct":10,"durationP95Ms":300000}',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      patch: {
        area: "health",
        what: "health.execution",
        condition: { params: { failureRatePct: 10, durationP95Ms: 300000 } },
      },
    });
    const result = await run("update_alert_draft", parsed.data);
    expect(result.ok).toBe(true);
    expect(result.patch.condition.params).toEqual({ failureRatePct: 10, durationP95Ms: 300000 });
  });

  it("still accepts the wrapped patch", () => {
    const input = {
      patch: {
        area: "health",
        what: "health.execution",
        condition: { kind: "threshold", params: { failureRatePct: 10 } },
      },
      reason: "Recommended",
    };
    expect(parseInput(input)).toMatchObject({ success: true, data: input });
  });

  // Mutation: replacing a non-object patch with the flat remainder fails this.
  it("rejects a patch that is not an object", () => {
    expect(parseInput({ patch: "x" }).success).toBe(false);
    expect(parseInput({ patch: null }).success).toBe(false);
  });

  it("parses a patch given as a JSON string", () => {
    expect(parseInput({ patch: '{"what":"health.execution"}' })).toMatchObject({
      success: true,
      data: { patch: { what: "health.execution" } },
    });
  });

  it("rejects params that are not JSON without throwing", () => {
    const parsed = parseInput({ what: "health.execution", params: "failureRatePct=10" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["patch", "condition", "params"]);
  });
});

describe("alert_creation draft context", () => {
  const draft: AlertCreationDraft = {
    capabilityKey: "queue.depth",
    answers: { area: "queues", what: "queue.depth", scope: "all", expiry: "24h" },
  };

  // Mutation: dropping the continue-setup line from the prompt fails this.
  it("tells the agent to end every creation reply by offering to continue the setup", () => {
    expect(DASHBOARD_AGENT_SYSTEM_PROMPT).toContain(
      "in alert_creation scope it always ends, even after a clarifying question, by asking whether to continue the setup"
    );
    expect(DASHBOARD_AGENT_WATCH_PROMPT).toContain("Watch limits don't apply to alerts");
  });

  // Mutation: capping expiry at 24h or restoring an enum fails this.
  it("accepts any alert expiry in a draft patch", async () => {
    for (const expiry of ["none", "37h", "30d", "2027-01-02T03:04:00.000Z"]) {
      const result = await run("update_alert_draft", { patch: { behavior: { expiry } } });
      expect(alertDraftPatchSchema.safeParse({ behavior: { expiry } }).success).toBe(true);
      expect(result.ok).toBe(true);
    }
    expect(alertDraftPatchSchema.safeParse({ behavior: { expiry: "forever" } }).success).toBe(
      false
    );
  });

  // Mutation: removing alertDraft from clientDataSchema strips the draft and fails this.
  it("parses the draft from the turn's client data", () => {
    const parsed = clientDataSchema.parse({
      userId: "user_1",
      organizationId: "org_1",
      toolScope: "alert_creation",
      alertDraft: draft,
    });
    expect(parsed.alertDraft).toEqual(draft);
    expect(
      clientDataSchema.safeParse({
        userId: "user_1",
        organizationId: "org_1",
        alertDraft: { answers: { windowMinutes: "ten" } },
      }).success
    ).toBe(false);
  });

  // Mutation: returning the messages unchanged fails this.
  it("appends the draft to the user's message", () => {
    const messages = withAlertDraftContext(
      [{ role: "user", content: "expire it in 37 hours" }],
      draft
    );
    const content = messages[0]!.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toBe("expire it in 37 hours");
    expect(content[1]!.text).toBe(alertDraftContextText(draft));
    expect(content[1]!.text).toContain('"expiry":"24h"');
    expect(withAlertDraftContext([{ role: "user", content: "hi" }], undefined)[0]!.content).toBe(
      "hi"
    );
  });
});

describe("describe_alert_capabilities prefill action", () => {
  const registryCaps = ["health.execution", "health.liveness", "queue.depth"].map((key) => {
    const c = getCapability(key)!;
    return { key: c.key, allowedKinds: c.allowedKinds, params: c.binding.params };
  });

  const describeWith = (ctx: Record<string, unknown>) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ capabilities: registryCaps }), { status: 200 })
      )
    );
    const full = { ...CTX, ...ctx };
    const set = buildMonitoringAlertTools({
      ctx: full as any,
      client: createApiClient(full as any),
    });
    return (set.describe_alert_capabilities as any).execute({}, {} as any) as Promise<any>;
  };

  const byKey = (result: any, key: string) => result.capabilities.find((c: any) => c.key === key);

  // Mutation: returning result.data unchanged drops nextAction and fails this.
  it("tells the agent to patch registry defaults on an empty draft", async () => {
    const result = await describeWith({ toolScope: "alert_creation", alertDraft: { answers: {} } });
    const action = byKey(result, "health.execution").nextAction;
    expect(action).toEqual({
      tool: "update_alert_draft",
      input: {
        patch: {
          what: "health.execution",
          condition: { kind: "state", params: { failureRatePct: 10, durationP95Ms: 300000 } },
        },
      },
      reason: expect.stringContaining("Do not ask the user"),
    });
    expect(byKey(result, "queue.depth").nextAction).toBeUndefined();
    expect((await run("update_alert_draft", action.input)).ok).toBe(true);
  });

  it("adds no action outside alert_creation scope", async () => {
    const result = await describeWith({});
    expect(byKey(result, "health.execution").nextAction).toBeUndefined();
  });

  it("adds no action once the draft has params", async () => {
    const result = await describeWith({
      toolScope: "alert_creation",
      alertDraft: { answers: { what: "health.execution", conditionParams: { failureRatePct: 5 } } },
    });
    expect(byKey(result, "health.execution").nextAction).toBeUndefined();
  });

  // Mutation: dropping the `answers.what` filter offers the action on every capability.
  it("offers the action only on the capability the draft already picked", async () => {
    const result = await describeWith({
      toolScope: "alert_creation",
      alertDraft: { answers: { what: "health.liveness" } },
    });
    expect(byKey(result, "health.liveness").nextAction?.input.patch).toEqual({
      what: "health.liveness",
      condition: { kind: "state", params: { silenceSec: 300 } },
    });
    expect(byKey(result, "health.execution").nextAction).toBeUndefined();
  });
});

describe("update_alert_draft operator", () => {
  it("rejects a below-threshold operator with a readable message", () => {
    const schema = updateAlertDraftSchema.inputSchema as unknown as {
      safeParse: (input: unknown) => { success: boolean; error?: { message: string } };
    };
    const result = schema.safeParse({ patch: { condition: { operator: "<", value: 10 } } });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Below-threshold alerts aren't supported yet");
  });
});
