import { buildScopeMatcher, type ApiKeyScopeUseEvent } from "@trigger.dev/plugins";
import { describe, expect, it, vi } from "vitest";
import { buildJwtAbility } from "./ability.js";
import { withActionAliases } from "./index.js";
import { recordingApiKeyAbility } from "./scopeUsage.js";

const target = { organizationId: "org_1", environmentId: "env_1", apiKeyId: "key_1" };

function recorded(scopes: string[]) {
  const events: ApiKeyScopeUseEvent[] = [];
  const ability = withActionAliases(
    recordingApiKeyAbility(scopes, target, (event) => events.push(event))
  );
  return { ability, events };
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

describe("buildScopeMatcher", () => {
  it("strips task ids from the matched scope", () => {
    const match = buildScopeMatcher(["write:tasks:report", "read:runs"]);
    expect(match("write", { type: "tasks", id: "report" })).toBe("write:tasks");
    expect(match("write", { type: "tasks", id: "other" })).toBeUndefined();
  });

  it("returns the first candidate that matches", () => {
    const match = buildScopeMatcher(["read:tags"]);
    expect(
      match("read", [
        { type: "runs", id: "run_1" },
        { type: "tags", id: "env:prod" },
      ])
    ).toBe("read:tags");
  });

  it("reports an all-resources scope as itself", () => {
    expect(buildScopeMatcher(["read:all"])("read", { type: "runs" })).toBe("read:all");
  });

  it("matches a wildcard action", () => {
    expect(buildScopeMatcher(["*:runs"])("read", { type: "runs", id: "run_1" })).toBe("*:runs");
  });

  it("reports what a full-access key was asked for", () => {
    const match = buildScopeMatcher(["admin"]);
    expect(match("update", { type: "runs", id: "run_1" })).toBe("write:runs");
    expect(match("trigger", [{ type: "tasks", id: "a" }, { type: "batch" }])).toBe("trigger:tasks");
  });

  it("agrees with buildJwtAbility", () => {
    const scopes = ["read:runs", "write:tasks:a", "batchTrigger:all", "read:tags:x"];
    const ability = buildJwtAbility(scopes);
    const match = buildScopeMatcher(scopes);
    const checks: [string, { type: string; id?: string }][] = [
      ["read", { type: "runs" }],
      ["read", { type: "runs", id: "r" }],
      ["write", { type: "tasks", id: "a" }],
      ["write", { type: "tasks", id: "b" }],
      ["batchTrigger", { type: "queues" }],
      ["read", { type: "tags", id: "x" }],
      ["read", { type: "tags", id: "y" }],
      ["write", { type: "runs" }],
    ];
    for (const [action, resource] of checks) {
      expect(match(action, resource) !== undefined).toBe(ability.can(action, resource));
    }
  });
});

describe("recordingApiKeyAbility", () => {
  it("records the scope an aliased check was allowed by", async () => {
    const { ability, events } = recorded(["write:tasks:hello"]);
    expect(ability.can("trigger", { type: "tasks", id: "hello" })).toBe(true);
    await nextTick();
    expect(events).toEqual([{ ...target, used: ["write:tasks"] }]);
  });

  it("sends one event for the checks a request makes together", async () => {
    const { ability, events } = recorded(["read:runs", "read:tags"]);
    ability.can("read", { type: "runs", id: "run_1" });
    ability.can("read", { type: "runs", id: "run_2" });
    ability.can("read", [{ type: "tags", id: "a" }]);
    await nextTick();
    expect(events).toEqual([{ ...target, used: ["read:runs", "read:tags"] }]);
  });

  it("does not send a scope twice for the same request", async () => {
    const { ability, events } = recorded(["read:runs"]);
    ability.can("read", { type: "runs" });
    await nextTick();
    ability.can("read", { type: "runs" });
    await nextTick();
    expect(events).toHaveLength(1);
  });

  it("records nothing for denied checks", async () => {
    const { ability, events } = recorded(["read:runs"]);
    expect(ability.can("write", { type: "runs" })).toBe(false);
    expect(ability.can("trigger", { type: "tasks" })).toBe(false);
    await nextTick();
    expect(events).toEqual([]);
  });

  it("keeps the request working when the recorder throws", async () => {
    const ability = recordingApiKeyAbility(["read:runs"], target, () => {
      throw new Error("down");
    });
    expect(ability.can("read", { type: "runs" })).toBe(true);
    await nextTick();
  });
});

vi.mock("@triggerdotdev/plugins/rbac", () => ({
  default: {
    create: () => ({
      isUsingPlugin: async () => true,
    }),
  },
}));

describe("LazyController scope usage defaults (plugin predates the contract)", () => {
  async function controller() {
    const loader = (await import("./index.js")).default;
    const instance = loader.create({} as never);
    await expect(instance.isUsingPlugin()).resolves.toBe(true);
    return instance;
  }

  it("reports usage as unavailable", async () => {
    await expect(
      (await controller()).apiKeyScopeUsage({
        organizationId: "org_1",
        windowDays: 30,
        apiKeys: [],
      })
    ).resolves.toBeNull();
  });

  it("ignores recorded use", async () => {
    const instance = await controller();
    expect(() => instance.recordApiKeyScopeUse({ ...target, used: ["read:runs"] })).not.toThrow();
  });
});
