import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthHolder, createProjectLookup, NO_CREDENTIALS } from "../mcp/projectLookup.js";
import { createMcpTelemetry } from "../mcp/telemetry.js";
import { isTriggerCloudApi } from "./apiUrl.js";
import { forgetKnownUser, rememberUserId } from "./knownUser.js";
import { argKeys, createAnalytics, trackCommand, type AnalyticsSink } from "./productAnalytics.js";

function arraySink() {
  const sent: Array<{
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
    groups?: Record<string, string>;
    timestamp?: Date;
  }> = [];
  const sink: AnalyticsSink = {
    send: (distinctId, { event, properties, groups, timestamp }) =>
      sent.push({ distinctId, event, properties, groups, timestamp }),
    shutdown: async () => {},
  };
  return { sent, sink };
}

const CLOUD = "https://api.trigger.dev";

const cloudUser = (userId = "user_1") => ({ userId, apiUrl: CLOUD });

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => {
  forgetKnownUser();
  delete process.env.TRIGGER_TELEMETRY_DISABLED;
});

describe("argKeys", () => {
  // Catches: argument values leaking into events, or unsorted keys.
  it("returns sorted names of provided arguments only", () => {
    expect(argKeys({ query: "secret", period: "7d", unset: undefined })).toEqual([
      "period",
      "query",
    ]);
    expect(argKeys(undefined)).toEqual([]);
  });
});

describe("createMcpTelemetry", () => {
  const options = { apiUrl: "http://x", profile: "default" };

  it("sends local tool events with a counter and no argument values", async () => {
    const { sent, sink } = arraySink();
    const telemetry = createMcpTelemetry(options, { sink, lookupUserId: async () => cloudUser() });

    telemetry.sessionStarted({ name: "claude-code", version: "2.1" });
    telemetry.toolCalled({
      tool: "query",
      ok: true,
      durationMs: 5,
      input: { query: "SELECT secret", environment: "prod" },
    });
    telemetry.toolCalled({ tool: "query", ok: false, durationMs: 7, input: {} });
    await settle();

    expect(sent.map((e) => e.properties.seq)).toEqual([undefined, 1, 2]);
    expect(sent[0]?.event).toBe("$mcp_initialize");
    expect(sent[1]).toMatchObject({
      distinctId: "user_1",
      event: "$mcp_tool_call",
      properties: {
        surface: "local",
        $session_id: telemetry.sessionId,
        $mcp_session_id: telemetry.sessionId,
        $mcp_tool_name: "query",
        $mcp_is_error: false,
        $mcp_source: "posthog_mcp_analytics",
        $mcp_client_name: "claude-code",
        $mcp_client_version: "2.1",
        outcome: "ok",
        argKeys: ["environment", "query"],
        environmentType: "PRODUCTION",
      },
    });
    expect(sent[2]?.properties).toMatchObject({
      outcome: "error",
      $mcp_is_error: true,
      $mcp_client_name: "claude-code",
    });
    expect(JSON.stringify(sent)).not.toContain("SELECT secret");

    telemetry.sessionStarted({ name: "n".repeat(300), version: "2.1" });
    telemetry.toolCalled({ tool: "query", ok: true, durationMs: 1, input: {} });
    await settle();
    expect(sent.at(-1)?.properties.$mcp_client_name).toBe("n".repeat(100));
    expect(telemetry.sessionId).toMatch(/^mcps_[0-9a-f-]{36}$/);
  });

  // Catches: groups keyed by the ref instead of ids, a failed lookup dropping the event, and
  // grouping a call by the server option when the tool resolved its project elsewhere.
  it("groups tool calls by organization and project ids, one lookup per ref", async () => {
    const { sent, sink } = arraySink();
    const lookups: string[] = [];
    const telemetry = createMcpTelemetry(
      { ...options, projectRef: "proj_default" },
      {
        sink,
        lookupUserId: async () => cloudUser(),
        lookupProject: async (ref) => {
          lookups.push(ref);
          if (ref === "proj_bad") throw new Error("nope");
          return { organizationId: "org_id", projectId: `id_of_${ref}` };
        },
      }
    );

    const call = (input: unknown) =>
      telemetry.toolCalled({ tool: "query", ok: true, durationMs: 1, input });
    call({ projectRef: "proj_a" });
    call({ projectRef: "proj_a" });
    call({});
    call({ projectRef: "proj_bad" });
    await settle();

    expect(sent.map((e) => e.groups)).toEqual([
      undefined,
      { organization: "org_id", project: "id_of_proj_a" },
      { organization: "org_id", project: "id_of_proj_a" },
      undefined,
    ]);
    expect(lookups.sort()).toEqual(["proj_a", "proj_bad"]);
  });

  const call = (t: ReturnType<typeof createMcpTelemetry>, input: unknown) =>
    t.toolCalled({ tool: "query", ok: true, durationMs: 1, input });
  const IDS = { organizationId: "org_id", projectId: "id_x" };
  const base = { lookupUserId: async () => cloudUser(), projectLookupTimeoutMs: 5 };

  // Catches: shutdown dropping an event that waits on a slow project lookup.
  it("sends a pending event without groups when shutdown starts", async () => {
    const { sent, sink } = arraySink();
    const telemetry = createMcpTelemetry(options, {
      ...base,
      sink,
      projectLookupTimeoutMs: 60_000,
      lookupProject: () => new Promise(() => {}),
    });

    call(telemetry, { projectRef: "proj_x" });
    await telemetry.shutdown(500);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.groups).toBeUndefined();
  });

  // Catches: stamping events at send time, so a slow lookup reorders them.
  it("stamps events when captured", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const { sent, sink } = arraySink();
      const telemetry = createMcpTelemetry(options, { ...base, sink });
      call(telemetry, {});
      vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
      await settle();

      expect(sent[0]?.timestamp?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  // Catches: one slow first lookup leaving the ref without groups for the whole process.
  it("keeps a timed-out lookup so a later event gets groups", async () => {
    const { sent, sink } = arraySink();
    let finish: (ids: typeof IDS) => void = () => {};
    const slow = new Promise<typeof IDS>((resolve) => (finish = resolve));
    const telemetry = createMcpTelemetry(options, { ...base, sink, lookupProject: () => slow });

    call(telemetry, { projectRef: "proj_x" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    finish(IDS);
    await settle();
    call(telemetry, { projectRef: "proj_x" });
    await settle();

    expect(sent.map((e) => e.groups)).toEqual([
      undefined,
      { organization: "org_id", project: "id_x" },
    ]);
  });

  // Catches: "no credentials yet" cached as a result, leaving the ref without groups for good.
  it("looks the ref up again once credentials exist", async () => {
    const { sent, sink } = arraySink();
    let ready = false;
    const telemetry = createMcpTelemetry(options, {
      ...base,
      sink,
      lookupProject: async () => (ready ? IDS : NO_CREDENTIALS),
    });

    call(telemetry, { projectRef: "proj_x" });
    await settle();
    ready = true;
    call(telemetry, { projectRef: "proj_x" });
    await settle();

    expect(sent.map((e) => e.groups?.project)).toEqual([undefined, "id_x"]);
  });

  // Catches: a ref that failed under one profile staying without groups under the next.
  it("looks a failed ref up again after the profile switches", async () => {
    const { sent, sink } = arraySink();
    let fail = true;
    const telemetry = createMcpTelemetry(options, {
      ...base,
      sink,
      lookupProject: async () => (fail ? undefined : IDS),
    });

    call(telemetry, { projectRef: "proj_x" });
    await settle();
    fail = false;
    telemetry.reset();
    call(telemetry, { projectRef: "proj_x" });
    await settle();

    expect(sent.map((e) => e.groups?.project)).toEqual([undefined, "id_x"]);
  });

  // Catches: ignoring the project the tool resolved from the working directory.
  it("groups a call by the ref the tool resolved, even when the input ref is empty", async () => {
    const { sent, sink } = arraySink();
    const telemetry = createMcpTelemetry(options, {
      ...base,
      sink,
      lookupProject: async (ref) => ({ organizationId: "org_id", projectId: `id_of_${ref}` }),
    });

    telemetry.toolCalled({
      tool: "query",
      ok: true,
      durationMs: 1,
      input: { projectRef: "" },
      resolvedProjectRef: "proj_cwd",
    });
    telemetry.toolCalled({
      tool: "query",
      ok: true,
      durationMs: 1,
      input: { projectRef: "proj_given" },
    });
    await settle();

    expect(sent.map((e) => e.groups?.project).sort()).toEqual([
      "id_of_proj_cwd",
      "id_of_proj_given",
    ]);
  });

  // Catches: an identity lookup started before a profile switch being used after it.
  it("ignores an identity lookup that started before a reset", async () => {
    const { sent, sink } = arraySink();
    let finishOld: (user: ReturnType<typeof cloudUser>) => void = () => {};
    let calls = 0;
    const telemetry = createMcpTelemetry(options, {
      ...base,
      sink,
      lookupUserId: () =>
        ++calls === 1
          ? new Promise((resolve) => (finishOld = resolve))
          : Promise.resolve(cloudUser("new_user")),
    });

    call(telemetry, {});
    telemetry.reset();
    finishOld(cloudUser("old_user"));
    call(telemetry, {});
    await settle();

    expect(sent.map((e) => e.distinctId)).toEqual(["new_user"]);
  });

  // Catches: a start for a superseded profile being sent, and blocking the new account's own.
  it("drops a session start whose profile was switched before the send", async () => {
    const { sent, sink } = arraySink();
    rememberUserId("old_user", CLOUD);
    const telemetry = createMcpTelemetry(options, { ...base, sink });

    telemetry.sessionStarted({ name: "claude-code", version: "2.1" });
    telemetry.reset();
    await settle();
    expect(sent).toEqual([]);

    rememberUserId("new_user", CLOUD);
    call(telemetry, {});
    await settle();

    expect(sent.map((e) => [e.distinctId, e.event])).toEqual([
      ["new_user", "$mcp_initialize"],
      ["new_user", "$mcp_tool_call"],
    ]);
  });

  // Catches: marking the session start as sent only after the sink call, so a switch landing
  // in between lets a second start go out under the same session id.
  it("never sends a second session start when the profile switches during the send", async () => {
    const sent: Array<{ distinctId: string; event: string }> = [];
    let telemetry: ReturnType<typeof createMcpTelemetry> | undefined;
    const sink: AnalyticsSink = {
      send: (distinctId, { event }) => {
        sent.push({ distinctId, event });
        if (event === "$mcp_initialize") telemetry?.reset();
      },
      shutdown: async () => {},
    };
    telemetry = createMcpTelemetry(options, { ...base, sink });

    telemetry.sessionStarted({ name: "claude-code", version: "2.1" });
    await settle();
    rememberUserId("new_user", CLOUD);
    call(telemetry, {});
    await settle();

    expect(sent.filter((e) => e.event === "$mcp_initialize")).toHaveLength(1);
  });

  // Catches: a start attempt from the old profile blocking the new account's initialize.
  it("retries the session start after a profile switch", async () => {
    const { sent, sink } = arraySink();
    let finishOld: (user: ReturnType<typeof cloudUser> | undefined) => void = () => {};
    const telemetry = createMcpTelemetry(options, {
      ...base,
      sink,
      lookupUserId: () => new Promise((resolve) => (finishOld = resolve)),
    });

    telemetry.sessionStarted({ name: "claude-code", version: "2.1" });
    telemetry.reset();
    rememberUserId("new_user", CLOUD);
    call(telemetry, {});
    await settle();
    finishOld(cloudUser("old_user"));
    await settle();
    call(telemetry, {});
    await settle();

    expect(sent.map((e) => [e.distinctId, e.event])).toEqual([
      ["new_user", "$mcp_initialize"],
      ["new_user", "$mcp_tool_call"],
      ["new_user", "$mcp_tool_call"],
    ]);
  });

  // Catches: the session never getting its initialize when the first login comes later.
  it("sends the initialize late, once, with the handshake time and client", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const { sent, sink } = arraySink();
      const telemetry = createMcpTelemetry(options, {
        ...base,
        sink,
        lookupUserId: async () => undefined,
      });

      telemetry.sessionStarted({ name: "claude-code", version: "2.1" });
      await settle();
      expect(sent).toEqual([]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
      rememberUserId("user_1", CLOUD);
      call(telemetry, {});
      await settle();
      call(telemetry, {});
      await settle();

      expect(sent.map((e) => e.event)).toEqual([
        "$mcp_initialize",
        "$mcp_tool_call",
        "$mcp_tool_call",
      ]);
      expect(sent[0]?.timestamp?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(sent[0]?.properties.$mcp_client_name).toBe("claude-code");
    } finally {
      vi.useRealTimers();
    }
  });

  // Catches: an agent-supplied ref reaching the API path.
  it.each(["../x", "proj_A", "proj_x/y"])("never looks up the malformed ref %s", async (ref) => {
    const { sent, sink } = arraySink();
    const lookups: string[] = [];
    const telemetry = createMcpTelemetry(options, {
      ...base,
      sink,
      lookupProject: async (r) => (lookups.push(r), IDS),
    });

    call(telemetry, { projectRef: ref });
    await settle();

    expect(lookups).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  // Catches: gating on the configured URL, so an id from a local server goes out as Cloud's.
  it.each(["http://localhost:3030", "https://trigger.example.com"])(
    "sends nothing, and looks nothing up, for an account resolved on %s",
    async (apiUrl) => {
      const { sent, sink } = arraySink();
      const lookups: string[] = [];
      const telemetry = createMcpTelemetry(options, {
        ...base,
        sink,
        lookupUserId: async () => ({ userId: "local_user", apiUrl }),
        lookupProject: async (r) => (lookups.push(r), IDS),
      });

      telemetry.sessionStarted({ name: "c", version: "1" });
      call(telemetry, { projectRef: "proj_x" });
      await settle();

      expect(sent).toEqual([]);
      expect(lookups).toEqual([]);
    }
  );

  // Catches: the account of the previous profile staying attached to events after a switch.
  it("does not reuse the previous profile's account after a switch", async () => {
    const { sent, sink } = arraySink();
    rememberUserId("cloud_user", CLOUD);
    const telemetry = createMcpTelemetry(options, {
      ...base,
      sink,
      lookupUserId: async () => ({ userId: "local_user", apiUrl: "http://localhost:3030" }),
    });

    call(telemetry, {});
    await settle();
    telemetry.reset();
    call(telemetry, {});
    await settle();

    expect(sent.map((e) => e.distinctId)).toEqual(["cloud_user"]);
  });

  // Catches: events sent although the user opted out.
  it.each([
    ["--skip-telemetry", { ...options, skipTelemetry: true }, undefined],
    ["TRIGGER_TELEMETRY_DISABLED", options, "1"],
  ])("sends nothing with %s", async (_name, opts, disabled) => {
    if (disabled) process.env.TRIGGER_TELEMETRY_DISABLED = disabled;
    const { sent, sink } = arraySink();
    const lookups: string[] = [];
    const telemetry = createMcpTelemetry(opts, {
      sink,
      lookupUserId: async () => cloudUser(),
      lookupProject: async (ref) => (lookups.push(ref), undefined),
    });

    telemetry.sessionStarted({ name: "c", version: "1" });
    telemetry.toolCalled({
      tool: "query",
      ok: true,
      durationMs: 1,
      input: { projectRef: "proj_1" },
    });
    await settle();

    expect(sent).toEqual([]);
    expect(lookups).toEqual([]);
  });

  // Catches: inventing an anonymous id when nobody is logged in.
  it("sends nothing without a user id", async () => {
    const { sent, sink } = arraySink();
    const telemetry = createMcpTelemetry(options, { sink, lookupUserId: async () => undefined });

    telemetry.toolCalled({ tool: "query", ok: true, durationMs: 1, input: {} });
    await settle();

    expect(sent).toEqual([]);
  });
});

describe("createAnalytics", () => {
  // Catches: a command hanging on exit while waiting for a user that never shows up.
  it("shutdown stays within its bound when the user id never arrives", async () => {
    const { sink } = arraySink();
    const analytics = createAnalytics({ enabled: true, sink });
    analytics.capture({ event: "e", properties: {} }, () => new Promise(() => {}));

    const startedAt = Date.now();
    await analytics.shutdown(50);

    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

describe("trackCommand", () => {
  // Catches: reporting a command run by an account resolved on a self-hosted server.
  it("sends nothing for an account resolved off Cloud", async () => {
    const { sent, sink } = arraySink();
    rememberUserId("local_user", "http://localhost:3030");

    const tracker = trackCommand("deployCommand", { cliVersion: "1.2.3", sink });
    await tracker.finish("success");

    expect(sent).toEqual([]);
  });

  const base = { cliVersion: "1.2.3" };

  it("reports dev once at start, after the user is known", async () => {
    const { sent, sink } = arraySink();
    trackCommand("dev", { ...base, sink });
    await settle();
    expect(sent).toEqual([]);

    rememberUserId("user_2", CLOUD);
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      distinctId: "user_2",
      event: "cli_command_run",
      properties: { command: "dev", outcome: "started", cliVersion: "1.2.3" },
    });
  });

  it("reports a finished command, but not a failed login", async () => {
    const { sent, sink } = arraySink();
    rememberUserId("user_2", CLOUD);

    await trackCommand("deployCommand", { ...base, sink }).finish("error");
    await trackCommand("loginCommand", { ...base, sink }).finish("error");
    await trackCommand("whoami", { ...base, sink }).finish("success");

    expect(sent.map((e) => [e.properties.command, e.properties.outcome])).toEqual([
      ["deploy", "error"],
    ]);
  });

  it("reports nothing with --skip-telemetry", async () => {
    const { sent, sink } = arraySink();
    rememberUserId("user_2", CLOUD);

    await trackCommand("deployCommand", { ...base, skipTelemetry: true, sink }).finish("success");

    expect(sent).toEqual([]);
  });
});

describe("createAuthHolder", () => {
  const auth = { apiUrl: CLOUD, accessToken: "t" };

  // Catches: an auth that resolves after a profile switch overwriting the new profile's.
  it("drops an auth that resolves after clear", () => {
    const holder = createAuthHolder();
    const stale = holder.begin();
    holder.clear();
    holder.set(stale, auth);
    expect(holder.get()).toBeUndefined();

    holder.set(holder.begin(), auth);
    expect(holder.get()).toBe(auth);
    holder.clear();
    expect(holder.get()).toBeUndefined();
  });
});

describe("createProjectLookup", () => {
  const ids = { organizationId: "o", projectId: "p" };

  // Catches: a lookup that falls back to interactive auth when nothing is resolved.
  it("only uses credentials already resolved", async () => {
    const used: unknown[] = [];
    const getProject = async (auth: unknown) => (used.push(auth), ids);
    const auth = { apiUrl: CLOUD, accessToken: "t" };

    expect(await createProjectLookup({ resolvedAuth: () => undefined, getProject })("proj_a")).toBe(
      NO_CREDENTIALS
    );
    expect(used).toEqual([]);
    expect(await createProjectLookup({ resolvedAuth: () => auth, getProject })("proj_a")).toBe(ids);
    expect(used).toEqual([auth]);
  });
});

describe("isTriggerCloudApi", () => {
  // Catches: matching on a substring or ignoring the scheme, which would report other servers.
  it.each([
    ["https://api.trigger.dev", true],
    ["https://api.trigger.dev/", true],
    ["https://api.trigger.dev/api/v1", true],
    ["https://api.trigger.dev:443", true],
    ["https://API.TRIGGER.DEV", true],
    ["https://test-cloud.trigger.dev", false],
    ["https://cloud.trigger.dev", false],
    ["https://api.trigger.dev.evil.com", false],
    ["https://evil.com/api.trigger.dev", false],
    ["https://api.trigger.dev:8443", false],
    ["http://api.trigger.dev", false],
    ["http://localhost:3030", false],
    ["https://trigger.example.com", false],
    ["not a url", false],
    ["", false],
  ])("%s", (url, expected) => {
    expect(isTriggerCloudApi(url)).toBe(expected);
  });
});
