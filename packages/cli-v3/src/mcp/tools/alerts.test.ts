import { describe, expect, it, vi } from "vitest";
import {
  createAlertTool,
  formatCapabilityLine,
  listAlertsTool,
  resolveAlertTool,
} from "./alerts.js";
import { AlertSchema, ListAlertCapabilitiesResponseBody } from "../../apiClient.js";
import { CreateAlertInput } from "../schemas.js";

describe("formatCapabilityLine", () => {
  it("fails when describe output omits params for health.all", () => {
    const line = formatCapabilityLine({
      key: "health.all",
      title: "Overall health",
      area: "health",
      allowedKinds: ["state"],
      allowedScopes: ["all"],
      params: [
        { key: "schedulingDelayMs", label: "Scheduling delay", default: 30000, unit: "ms" },
        { key: "backlogCount", label: "Backlog count", default: 100 },
      ],
    });

    expect(line).toContain("params:");
    expect(line).toContain("schedulingDelayMs (Scheduling delay, default=30000 ms)");
    expect(line).toContain("backlogCount (Backlog count, default=100)");
  });

  it("omits the params segment when a capability has no params", () => {
    const line = formatCapabilityLine({
      key: "queue.depth",
      title: "Queue depth",
      area: "queues",
      allowedKinds: ["threshold"],
      allowedScopes: ["queue"],
    });

    expect(line).not.toContain("params:");
  });
});

describe("alert API response schemas", () => {
  it("keeps binding.params from a capabilities payload", () => {
    const parsed = ListAlertCapabilitiesResponseBody.parse({
      capabilities: [
        {
          key: "health.all",
          area: "health",
          signal: "metric",
          title: "Health",
          allowedKinds: ["state"],
          allowedScopes: ["all"],
          curated: true,
          binding: {
            type: "query",
            minCadenceSec: 300,
            params: [{ key: "silenceSec", label: "Silence", default: 300, min: 60 }],
          },
        },
      ],
    });

    expect(parsed.capabilities[0]!.params).toEqual([
      { key: "silenceSec", label: "Silence", default: 300, min: 60 },
    ]);
  });

  it("accepts an alert row with a null name", () => {
    const row = {
      id: "a1",
      environmentId: "env_1",
      capabilityKey: "queue.depth",
      params: {},
      condition: {},
      lifecycle: "active",
      attention: "clear",
      name: null,
      notifiers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(AlertSchema.parse(row).name).toBeNull();
  });

  it("accepts an errorGroup-scoped create input", () => {
    const parsed = CreateAlertInput.parse({
      projectRef: "proj_123",
      capabilityKey: "errors.occurred_again",
      params: { scope: { type: "errorGroup", taskIdentifier: "t", fingerprint: "fp" } },
      condition: { kind: "occurrence" },
      behavior: {},
      notifiers: [{ type: "chat", chatId: "chat_1" }],
    });

    expect(parsed.params.scope).toMatchObject({ type: "errorGroup", fingerprint: "fp" });
  });
});

describe("alert tools with --dev-only", () => {
  const makeCtx = (devOnly: boolean) => {
    const api = {
      listAlerts: vi.fn().mockResolvedValue({ success: true, data: { alerts: [] } }),
      createAlert: vi.fn().mockResolvedValue({
        success: true,
        data: { alert: { id: "a1", capabilityKey: "health.all" } },
      }),
      resolveAlert: vi.fn().mockResolvedValue({ success: true, data: { alert: { id: "a1" } } }),
      getAlert: vi.fn().mockResolvedValue({
        success: true,
        data: { alert: { id: "a1" }, events: [], environmentType: "DEVELOPMENT" },
      }),
    };
    const ctx = {
      options: { devOnly },
      getProjectRef: vi.fn().mockResolvedValue("proj_1"),
      getCliApiClient: vi.fn().mockResolvedValue(api),
    };
    return { api, ctx };
  };

  const createInput = {
    capabilityKey: "health.all",
    params: {},
    condition: { kind: "state", stateKey: "unhealthy" },
    behavior: {},
    notifiers: [{ type: "channel", channelId: "c1" }],
  };

  const cases = [
    ["list_alerts", listAlertsTool, "listAlerts", {}],
    ["create_alert", createAlertTool, "createAlert", createInput],
    ["resolve_alert", resolveAlertTool, "resolveAlert", { alertId: "a1" }],
  ] as const;

  for (const [name, tool, method, extra] of cases) {
    for (const environment of ["prod", "staging", "preview"]) {
      it(`${name} rejects ${environment} before any API call`, async () => {
        const { api, ctx } = makeCtx(true);
        const res: any = await (tool.handler as any)(
          { ...extra, environment, projectRef: "proj_1" },
          { ctx }
        );
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("--dev-only");
        expect(ctx.getProjectRef).not.toHaveBeenCalled();
        expect(api[method]).not.toHaveBeenCalled();
      });
    }

    it(`${name} allows dev`, async () => {
      const { api, ctx } = makeCtx(true);
      const res: any = await (tool.handler as any)(
        { ...extra, environment: "dev", projectRef: "proj_1" },
        { ctx }
      );
      expect(res.isError).toBeFalsy();
      expect(api[method]).toHaveBeenCalledTimes(1);
    });
  }

  it("resolve_alert rejects a production alert id even with environment dev", async () => {
    const { api, ctx } = makeCtx(true);
    api.getAlert.mockResolvedValue({
      success: true,
      data: { alert: { id: "a1" }, events: [], environmentType: "PRODUCTION" },
    });
    const res: any = await (resolveAlertTool.handler as any)(
      { alertId: "a1", environment: "dev", projectRef: "proj_1" },
      { ctx }
    );
    expect(res.isError).toBe(true);
    expect(api.resolveAlert).not.toHaveBeenCalled();
  });

  it("resolve_alert skips the lookup when not dev-only", async () => {
    const { api, ctx } = makeCtx(false);
    await (resolveAlertTool.handler as any)(
      { alertId: "a1", environment: "prod", projectRef: "proj_1" },
      { ctx }
    );
    expect(api.getAlert).not.toHaveBeenCalled();
    expect(api.resolveAlert).toHaveBeenCalledTimes(1);
  });
});
