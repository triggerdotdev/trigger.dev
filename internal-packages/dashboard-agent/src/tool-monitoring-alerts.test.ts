import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAnalyzeQueryAlertTool,
  buildMonitoringAlertTools,
  buildPlanMonitoringTool,
  _validateDraftPatch,
} from "./tool-monitoring-alerts";
import { createApiClient } from "./tool-api-client";
import {
  DASHBOARD_AGENT_MONITORING_ALERT_TOOL_NAMES,
  DASHBOARD_AGENT_SYSTEM_PROMPT,
  dashboardAgentToolSchemas,
  planMonitoringSchema,
  describeAlertCapabilitiesInputSchema,
  updateAlertDraftSchema,
} from "./tool-schemas";
import {
  alertDraftPatchSchema,
  type AlertCreationDraft,
} from "@internal/dashboard-agent-contracts";
import {
  alertDraftContextText,
  systemPromptFor,
  toolSchemasFor,
  withAlertDraftContext,
} from "./prompt-assembly";
import { clientDataSchema, scopeTurnTools } from "./agent-runtime";
import { buildDashboardAgentTools } from "./tools";
import { alertAreaSchema, getCapability } from "@internal/alert-contracts";

describe("creation turn tools on the agent run", () => {
  const base = { userActorToken: "uat", apiOrigin: "https://api.example.com", chatId: "chat_1" };

  it.each([false, true])("offers update_alert_draft (alerts %s)", (alerts) => {
    const clientData = { ...base, alertsEnabled: alerts, toolScope: "alert_creation" };
    const tools = scopeTurnTools(buildDashboardAgentTools(clientData), clientData);
    expect(tools).toHaveProperty("update_alert_draft");
    expect(tools).toHaveProperty("describe_alert_capabilities");
    expect(Object.keys(tools)).toEqual(
      Object.keys(toolSchemasFor("assistant", { alertsEnabled: alerts, scope: "alert_creation" }))
    );
  });

  it("leaves a normal turn's tools alone", () => {
    const clientData = { ...base, toolScope: undefined };
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
  const ctx = { ...CTX, toolScope: "alert_creation" };
  return buildMonitoringAlertTools({ ctx: ctx as any, client: createApiClient(ctx as any) });
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
  it("lists the alert areas except query and grouped", () => {
    const areaField = describeAlertCapabilitiesInputSchema.shape.area.unwrap();
    expect(areaField.options).toEqual(
      alertAreaSchema.options.filter((a) => a !== "query" && a !== "grouped")
    );
    expect(areaField.options).toEqual(["queues", "runs", "health", "limits", "errors"]);
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

  it("fails when alert_creation scope includes resolve_monitoring_alert", () => {
    const scopeTools = toolSchemasFor("assistant", { scope: "alert_creation" });
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
  const schema = updateAlertDraftSchema.inputSchema as unknown as {
    safeParse: (input: unknown) => { success: boolean; data?: any };
  };

  it("rejects a below-threshold operator on a curated patch with a readable message", async () => {
    const parsed = schema.safeParse({
      patch: { area: "queues", condition: { operator: "<", value: 10 } },
    });
    expect(parsed.success).toBe(true);
    const result = await run("update_alert_draft", parsed.data);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Below-threshold alerts aren't supported yet");
  });

  it("accepts a below-threshold operator on a query patch", async () => {
    const parsed = schema.safeParse({
      patch: {
        area: "query",
        query: "SELECT count() AS failures FROM runs",
        querySignalChoice: { mode: "threshold", measure: "failures" },
        condition: { operator: "<" },
      },
    });
    expect(parsed.success).toBe(true);
    const result = await run("update_alert_draft", parsed.data);
    expect(result.ok).toBe(true);
    expect(result.patch.condition).toEqual({ operator: "<" });
  });
});

describe("query alerts", () => {
  const query = "SELECT count() AS failures FROM runs WHERE status = 'Failed'";

  it("analyze_query_alert posts the query and returns the analysis", async () => {
    let call: { url: string; body: any } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        call = { url, body: JSON.parse(init?.body ?? "{}") };
        return new Response(JSON.stringify({ analysis: { ok: true, modes: [] } }), {
          status: 200,
        });
      })
    );
    const tool = buildAnalyzeQueryAlertTool({
      ctx: CTX as any,
      client: createApiClient(CTX as any),
    }).analyze_query_alert as any;

    const result = await tool.execute({ query }, {} as any);

    expect(call?.url).toBe(`${ORIGIN}/api/v1/dashboard-agent/monitoring-alerts/analyze-query`);
    expect(call?.body).toEqual({ query });
    expect(result).toEqual({ analysis: { ok: true, modes: [] } });
  });

  it("is registered for alert turns, after submit_feedback", () => {
    const keys = Object.keys(dashboardAgentToolSchemas);
    expect(keys.indexOf("analyze_query_alert")).toBe(keys.indexOf("submit_feedback") + 1);
    expect(DASHBOARD_AGENT_MONITORING_ALERT_TOOL_NAMES).toContain("analyze_query_alert");
    expect(toolSchemasFor("assistant", { scope: "alert_creation" })).toHaveProperty(
      "analyze_query_alert"
    );
  });

  // Mutation: dropping "query" from the patch area enum fails the first call.
  it("update_alert_draft accepts a query patch and requires the query", async () => {
    const patch = {
      area: "query",
      query,
      querySignalChoice: { mode: "threshold", measure: "failures" },
    };
    const parsed = (tools().update_alert_draft as any).inputSchema.safeParse({ patch });
    expect(parsed.success).toBe(true);
    const result = await run("update_alert_draft", parsed.data);
    expect(result.ok).toBe(true);
    expect(result.patch).toEqual(patch);

    const missing = await run("update_alert_draft", { patch: { area: "query" } });
    expect(missing.ok).toBe(false);
    expect(missing.errors).toContainEqual(expect.stringContaining("needs query"));
  });
});

describe("Limits condition fields", () => {
  const fields = {
    compositeMode: "all",
    components: ["limits.api", "limits.webhooks.waiters"],
    signals: ["approaching"],
  };

  it("update_alert_draft keeps the fields in the patch", async () => {
    const patch = { what: "limits.all", condition: { kind: "state", ...fields } };
    const parsed = (tools().update_alert_draft as any).inputSchema.parse({ patch });
    const result = await run("update_alert_draft", parsed);
    expect(result.ok).toBe(true);
    expect(result.patch.condition).toMatchObject(fields);
  });

  it("rejects components outside the composite, empty and unsupported signals", async () => {
    const bad = (condition: object, what = "limits.all") =>
      run("update_alert_draft", { patch: { what, condition } });
    expect((await bad({ components: ["queue.depth"] })).ok).toBe(false);
    expect((await bad({ signals: [] }, "limits.api")).ok).toBe(false);
    expect((await bad({ signals: ["limited"] }, "limits.queue")).ok).toBe(false);
    expect((await bad({ signals: ["limited"] }, "limits.api")).ok).toBe(true);
    expect((await bad({ components: ["limits.queue"], signals: ["limited"] })).ok).toBe(false);
    expect((await bad({ components: ["limits.api"], signals: ["limited"] })).ok).toBe(true);
  });

  // Catches: health.all components not validated by the agent tool.
  it("accepts health.all components and rejects unknown ones", async () => {
    const draft = (components: string[]) =>
      run("update_alert_draft", {
        patch: { what: "health.all", condition: { kind: "state", components } },
      });
    expect((await draft(["health.flow", "health.liveness"])).ok).toBe(true);
    expect((await draft(["health.nope"])).ok).toBe(false);
  });

  it("states the framing line in the prompt", () => {
    expect(DASHBOARD_AGENT_SYSTEM_PROMPT).toContain(
      "Limits covers limits that can interrupt or degrade runtime flow; for a composite pick components and any/all, for a limit pick signals."
    );
  });

  it("describe_alert_capabilities mentions groups and supported signals", () => {
    const description = (dashboardAgentToolSchemas.describe_alert_capabilities as any).description;
    expect(description).toContain("groups: platform, webhooks");
    expect(description).toContain("supportedSignals");
  });
});

describe("draft name", () => {
  it("update_alert_draft carries a name in the patch", async () => {
    const parsed = (tools().update_alert_draft as any).inputSchema.parse({
      patch: { what: "queue.depth", name: "Payments depth" },
    });
    const result = await run("update_alert_draft", parsed);
    expect(result.ok).toBe(true);
    expect(result.patch.name).toBe("Payments depth");
  });
});

describe("plan_monitoring", () => {
  const LIMIT_MESSAGE =
    "Remove LIMIT, OFFSET and LIMIT BY: an alert looks at every matching row, and a top-N cut makes it fire on ranking changes.";

  const failureRate = {
    id: "p1",
    title: "Failure rate",
    description: "Catches a deploy that makes runs fail.",
    draft: {
      area: "runs",
      what: "runs.failure_rate",
      condition: { kind: "threshold", operator: ">", value: 5, windowSec: 600 },
    },
  };

  const plan = (items: unknown[]) =>
    (
      buildPlanMonitoringTool({
        ctx: { ...CTX, environmentId: "env_1" } as any,
        client: createApiClient(CTX as any),
      }).plan_monitoring as any
    ).execute({ goal: "Keep an eye on prod after this deploy", items }, {} as any) as Promise<
      Record<string, any>
    >;

  it("returns the plan with a summary per item", async () => {
    const result = await plan([failureRate]);
    expect(result.ok).toBe(true);
    expect(result.plan.items[0].summary).toBe("runs.failure_rate · threshold > 5 · all");
    expect(result.plan.environmentId).toBe("env_1");
  });

  const planSignals = (what: string, condition: object) =>
    plan([{ ...failureRate, draft: { area: "limits", what, condition } }]);

  // Catches: unsupported signals reaching validation and failing the plan.
  it("drops signals the capability doesn't support instead of failing", async () => {
    const result = await planSignals("limits.queue", {
      kind: "state",
      signals: ["limited", "approaching"],
    });
    expect(result.ok).toBe(true);
    expect(result.plan.items[0].draft.condition.signals).toEqual(["approaching"]);
  });

  // Catches: an item without a condition reaching the UI, or the retry text losing its silence.
  it("rejects a threshold item with no condition and tells the model to retry silently", async () => {
    const result = await plan([
      { ...failureRate, draft: { area: "runs", what: "runs.failure_rate" } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors[0].id).toBe("p1");
    expect(result.retry).toBe(
      "Fix and call plan_monitoring again; do not tell the user about this."
    );
  });

  // Catches: health.all with no condition rejected instead of taking its defaults.
  it("gives a state capability its default condition", async () => {
    const result = await plan([{ ...failureRate, draft: { area: "health", what: "health.all" } }]);
    expect(result.ok).toBe(true);
    expect(result.plan.items[0].draft.condition).toEqual({ kind: "state", compositeMode: "any" });
  });

  // Catches: health.all components dropped or rejected, so the baseline duplicates a task item.
  it("keeps health.all components in a plan", async () => {
    const components = ["health.flow", "health.liveness"];
    const result = await plan([
      {
        ...failureRate,
        draft: { area: "health", what: "health.all", condition: { kind: "state", components } },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.plan.items[0].draft.condition.components).toEqual(components);
  });

  // Catches: the agent's summary being replaced by the generated one.
  it("keeps a supplied summary", async () => {
    const result = await plan([{ ...failureRate, summary: "Failures after deploy" }]);
    expect(result.plan.items[0].summary).toBe("Failures after deploy");
  });

  // Catches: a spike query item shipping with an absence condition.
  it("rejects a spike-titled query item whose condition is absence", async () => {
    stubAnalyze(ABSENCE_RESPONSE);
    const item = {
      ...queryItem("p5", "SELECT count() AS runs FROM runs", { mode: "absence" }),
      title: "Triggered runs spike",
    };
    const result = await plan([item]);
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain("spike");

    const calm = { ...item, title: "No more than 5 runs" };
    expect((await plan([calm])).ok).toBe(true);

    const quiet = { ...item, title: "No runs for more than 5 minutes" };
    expect((await plan([quiet])).ok).toBe(true);

    const threshold = {
      ...item,
      draft: { ...item.draft, condition: { operator: ">", value: 100, windowSec: 300 } },
    };
    const fixed = await plan([threshold]);
    expect(fixed.plan.items[0].draft.querySignalChoice.mode).toBe("threshold");
    expect(fixed.plan.items[0].draft.condition.kind).toBe("threshold");
  });

  // Catches: a plan item summary or detail carrying concrete numbers into the plan card.
  it.each([
    ["summary", "More than 300 runs per hour", "handle-webhook p95 duration"],
    ["summary", "> 50 runs", "batch-1 failure rate"],
    ["summary", "> 50 runs", "gpt-4.1 latency"],
    [
      "detail",
      "Fires when more than 5% of runs fail.",
      "Fires when p95 duration rises above normal.",
    ],
  ])("rejects a %s containing a number", async (field, bad, good) => {
    const result = await plan([{ ...failureRate, [field]: bad }]);
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain(`${field} must not contain numbers`);
    expect(result.retry).toContain("call plan_monitoring again");
    const ok = await plan([{ ...failureRate, [field]: good }]);
    expect(ok.ok).toBe(true);
  });

  // Catches: summary and detail optional or unbounded in the tool input.
  it("requires a short summary and a detail in the input", () => {
    const { inputSchema } = planMonitoringSchema as any;
    const input = (item: object) => ({
      goal: "g",
      intro: "Watch it?",
      items: [{ ...failureRate, summary: "s", detail: "d", ...item }],
    });
    expect(inputSchema.safeParse(input({})).success).toBe(true);
    expect(inputSchema.safeParse(input({ summary: undefined })).success).toBe(false);
    expect(inputSchema.safeParse(input({ detail: undefined })).success).toBe(false);
    expect(inputSchema.safeParse(input({ summary: "x".repeat(61) })).success).toBe(false);
  });

  // Catches: empty signals failing the plan instead of taking the capability default.
  it("defaults empty signals to the capability's", async () => {
    const result = await planSignals("limits.api", { kind: "state", signals: [] });
    expect(result.ok).toBe(true);
    expect(result.plan.items[0].draft.condition.signals).toEqual(["limited"]);
  });

  // Mutation: skipping validateDraftPatch in plan_monitoring lets the bad key through.
  it("names the item whose curated draft is invalid", async () => {
    const bad = { ...failureRate, id: "p2", draft: { ...failureRate.draft, what: "runs.nope" } };
    const result = await plan([failureRate, bad]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ id: "p2", message: expect.stringContaining("runs.nope") }]);
  });

  // Fixtures in the analyze-query route's response shape. The route and its signal verdict
  // are tested against the real analyzer in webapp test/dashboardAgentMonitoringAlerts.test.ts.
  const LIMIT_RESPONSE = {
    analysis: {
      ok: false,
      modes: [],
      errors: [{ code: "limit", message: LIMIT_MESSAGE }],
      unsupported: [],
    },
    signal: { ok: false, message: LIMIT_MESSAGE },
  };
  const ABSENCE_RESPONSE = {
    analysis: {
      ok: true,
      modes: [
        {
          mode: "threshold",
          measures: [{ column: "runs", countLike: true }],
          absenceAllowed: true,
        },
      ],
      errors: [],
      unsupported: [],
    },
    signal: { ok: true },
  };

  function stubAnalyze(response: unknown) {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
        return new Response(JSON.stringify(response), { status: 200 });
      })
    );
    return calls;
  }

  const queryItem = (id: string, query: string, querySignalChoice: object) => ({
    id,
    title: "Query alert",
    description: "Backs the goal with a query.",
    draft: {
      area: "query",
      query,
      querySignalChoice,
      condition: (querySignalChoice as { mode: string }).mode === "absence" ? {} : { value: 5 },
    },
  });

  // Mutation: not calling the analyze-query route lets the LIMIT query through.
  it("rejects a query item the server can't back, with its message", async () => {
    const calls = stubAnalyze(LIMIT_RESPONSE);
    const query = "SELECT task_identifier, count() AS n FROM runs GROUP BY task_identifier LIMIT 5";
    const result = await plan([
      failureRate,
      queryItem("p3", query, { mode: "threshold", measure: "n" }),
    ]);
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/v1/dashboard-agent/monitoring-alerts/analyze-query`);
    expect(calls[0]?.body).toEqual({ query, signal: { mode: "threshold", measure: "n" } });
    expect(result).toMatchObject({ ok: false, errors: [{ id: "p3", message: LIMIT_MESSAGE }] });
  });

  it("accepts an absence item the server accepts", async () => {
    const calls = stubAnalyze(ABSENCE_RESPONSE);
    const query = "SELECT count() AS runs FROM runs WHERE task_identifier = 'checkout'";
    const result = await plan([queryItem("p4", query, { mode: "absence" })]);
    expect(calls[0]?.body.signal).toEqual({ mode: "absence" });
    expect(result.ok).toBe(true);
  });

  // Mutation: dropping planConditionGaps from plan_monitoring lets the incomplete items through.
  it("requires the condition fields each capability kind needs", async () => {
    const missing = async (what: string, condition: object) => {
      const result = await plan([
        { ...failureRate, draft: { ...failureRate.draft, what, condition } },
      ]);
      return result.ok ? "" : result.errors[0].message;
    };
    expect(await missing("runs.failure_rate", { kind: "threshold" })).toBe(
      "missing condition.operator; missing condition.value"
    );
    expect(await missing("runs.failure_rate", { operator: ">", value: 5 })).toBe("");
    expect(await missing("runs.created", { kind: "absence" })).toBe("missing condition.windowSec");
    expect(await missing("runs.created", { kind: "absence", windowSec: 3600 })).toBe("");
    expect(await missing("errors.new", { kind: "occurrence" })).toBe("");
    expect(await missing("queue.stalled", { kind: "state" })).toBe("");
    const query = await plan([
      {
        ...failureRate,
        draft: {
          area: "query",
          query: "SELECT count() AS n FROM runs",
          querySignalChoice: { mode: "threshold", measure: "n" },
          condition: { windowSec: 600 },
        },
      },
    ]);
    expect(query.errors?.[0]?.message).toBe("missing condition.value");
  });

  // Mutation: dropping the duplicate-id check lets both items through.
  it("rejects a repeated item id", async () => {
    const result = await plan([failureRate, failureRate]);
    expect(result).toMatchObject({ ok: false, errors: [{ id: "p1", message: "duplicate id" }] });
  });

  // Mutation: dropping planScopeGaps ships a card the user can't create.
  it("names the item whose task scope has no task", async () => {
    const noTask = { ...failureRate, draft: { ...failureRate.draft, scope: { type: "task" } } };
    const result = await plan([noTask]);
    expect(result).toMatchObject({
      ok: false,
      errors: [{ id: "p1", message: "pick a task (scope)" }],
    });
  });

  it("names the item whose capability has no all scope and no scope was given", async () => {
    const again = {
      ...failureRate,
      draft: {
        ...failureRate.draft,
        what: "errors.occurred_again",
        condition: { kind: "occurrence" },
      },
    };
    const result = await plan([again]);
    expect(result.errors).toEqual([
      { id: "p1", message: expect.stringContaining("pick an error (scope)") },
    ]);
  });

  // Mutation: dropping the errorGroup completeness check lets a card through that can't be created.
  it("names the item whose error scope has no task", async () => {
    const again = {
      ...failureRate,
      draft: {
        ...failureRate.draft,
        area: "errors",
        what: "errors.occurred_again",
        condition: { kind: "occurrence" },
        scope: { type: "errorGroup", fingerprint: "744b4159" },
      },
    };
    const result = await plan([again]);
    expect(result).toMatchObject({
      ok: false,
      errors: [{ id: "p1", message: "pick an error (scope)" }],
    });
  });

  it("accepts a task scope with its task", async () => {
    const scoped = {
      ...failureRate,
      draft: { ...failureRate.draft, scope: { type: "task", value: "attempt-failures" } },
    };
    expect((await plan([scoped])).ok).toBe(true);
  });

  // Mutation: requiring notifiers again fails the pass with "missing notifiers".
  it("accepts items without notifiers and adds none", async () => {
    const result = await plan([failureRate]);
    expect(result.ok).toBe(true);
    expect(result.plan.items[0].draft.notifiers).toBeUndefined();
  });

  it("is the last tool and an alert tool", () => {
    expect(Object.keys(dashboardAgentToolSchemas).slice(-2)).toEqual([
      "plan_monitoring",
      "plan_decision",
    ]);
    expect(DASHBOARD_AGENT_MONITORING_ALERT_TOOL_NAMES).toContain("plan_monitoring");
  });
});

// Catches: the planner section left in the base prompt, offering a plan with no tool behind it.
describe("what the model is told about planning alerts", () => {
  const PLANNER = /plan_monitoring|plan_decision|Set up a watch/;
  for (const mode of ["assistant", "code"] as const) {
    it.each([
      [{}, false],
      [{ alertsEnabled: true }, true],
      [{ alertsEnabled: true, scope: "alert_creation" as const }, false],
    ])(`in ${mode} mode with %o, mentions the planner: %s`, (options, expected) => {
      expect(PLANNER.test(systemPromptFor(mode, options))).toBe(expected);
    });
  }
});
