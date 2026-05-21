import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClientManager, sdkScope, taskContext } from "@trigger.dev/core/v3";
import { auth, configure } from "./auth.js";
import { runs } from "./runs.js";
import { TriggerClient } from "./triggerClient.js";

type CapturedRequest = {
  url: string;
  authorization: string | undefined;
  branch: string | undefined;
};

function installFetchSpy() {
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const headers = new Headers(init?.headers);
    captured.push({
      url,
      authorization: headers.get("authorization") ?? undefined,
      branch: headers.get("x-trigger-branch") ?? undefined,
    });
    // Return a fake successful response shaped like an empty run retrieval.
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    captured,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("TriggerClient", () => {
  let fetchSpy: ReturnType<typeof installFetchSpy>;

  beforeEach(() => {
    apiClientManager.disable();
    fetchSpy = installFetchSpy();
  });

  afterEach(() => {
    fetchSpy.restore();
    apiClientManager.disable();
    taskContext.disable();
    vi.unstubAllEnvs();
  });

  it("throws on first API call when no accessToken is configured anywhere", () => {
    const client = new TriggerClient();
    expect(() => client.runs.list({ limit: 1 })).toThrow(/TRIGGER_SECRET_KEY/);
  });

  it("falls back to env vars when constructor config is empty", async () => {
    vi.stubEnv("TRIGGER_SECRET_KEY", "tr_dev_env_token");
    vi.stubEnv("TRIGGER_PREVIEW_BRANCH", "env-branch");

    const client = new TriggerClient();
    await client.runs.retrieve("run_abc").catch(() => undefined);

    expect(fetchSpy.captured).toHaveLength(1);
    expect(fetchSpy.captured[0]!.authorization).toBe("Bearer tr_dev_env_token");
    expect(fetchSpy.captured[0]!.branch).toBe("env-branch");
  });

  it("uses the instance accessToken and previewBranch on outgoing requests", async () => {
    const client = new TriggerClient({
      accessToken: "tr_preview_instance_token",
      previewBranch: "signup-flow",
    });

    await client.runs.retrieve("run_abc").catch(() => undefined);

    expect(fetchSpy.captured).toHaveLength(1);
    const req = fetchSpy.captured[0]!;
    expect(req.authorization).toBe("Bearer tr_preview_instance_token");
    expect(req.branch).toBe("signup-flow");
  });

  it("fills missing fields from env, but explicit constructor values still win", async () => {
    vi.stubEnv("TRIGGER_SECRET_KEY", "tr_env_token");
    vi.stubEnv("TRIGGER_PREVIEW_BRANCH", "env-branch");
    vi.stubEnv("TRIGGER_API_URL", "https://env.example.com");

    const explicit = new TriggerClient({
      accessToken: "tr_explicit",
      previewBranch: "explicit-branch",
    });
    const fromEnv = new TriggerClient();

    await Promise.all([
      explicit.runs.retrieve("run_a").catch(() => undefined),
      fromEnv.runs.retrieve("run_b").catch(() => undefined),
    ]);

    const byRun = Object.fromEntries(
      fetchSpy.captured.map((r) => [r.url.split("/runs/")[1]?.split(/[/?]/)[0], r])
    );

    expect(byRun["run_a"]!.authorization).toBe("Bearer tr_explicit");
    expect(byRun["run_a"]!.branch).toBe("explicit-branch");
    expect(byRun["run_b"]!.authorization).toBe("Bearer tr_env_token");
    expect(byRun["run_b"]!.branch).toBe("env-branch");
    expect(byRun["run_a"]!.url.startsWith("https://env.example.com/")).toBe(true);
  });

  it("does not leak instance config to the global apiClientManager", async () => {
    configure({ accessToken: "tr_dev_global_token" });

    const client = new TriggerClient({
      accessToken: "tr_preview_instance_token",
      previewBranch: "signup-flow",
    });

    await client.runs.retrieve("run_instance").catch(() => undefined);
    await runs.retrieve("run_global").catch(() => undefined);

    expect(fetchSpy.captured).toHaveLength(2);
    expect(fetchSpy.captured[0]!.authorization).toBe("Bearer tr_preview_instance_token");
    expect(fetchSpy.captured[0]!.branch).toBe("signup-flow");
    expect(fetchSpy.captured[1]!.authorization).toBe("Bearer tr_dev_global_token");
    expect(fetchSpy.captured[1]!.branch).toBeUndefined();
  });

  it("keeps two concurrent instances isolated from each other", async () => {
    const prod = new TriggerClient({ accessToken: "tr_prod_key" });
    const preview = new TriggerClient({
      accessToken: "tr_preview_key",
      previewBranch: "feature-x",
    });

    await Promise.all([
      prod.runs.retrieve("run_a").catch(() => undefined),
      preview.runs.retrieve("run_b").catch(() => undefined),
      prod.runs.retrieve("run_c").catch(() => undefined),
      preview.runs.retrieve("run_d").catch(() => undefined),
    ]);

    expect(fetchSpy.captured).toHaveLength(4);
    const byPath = Object.fromEntries(
      fetchSpy.captured.map((r) => [r.url.split("/runs/")[1]?.split(/[/?]/)[0], r])
    );

    expect(byPath["run_a"]!.authorization).toBe("Bearer tr_prod_key");
    expect(byPath["run_a"]!.branch).toBeUndefined();
    expect(byPath["run_c"]!.authorization).toBe("Bearer tr_prod_key");
    expect(byPath["run_c"]!.branch).toBeUndefined();
    expect(byPath["run_b"]!.authorization).toBe("Bearer tr_preview_key");
    expect(byPath["run_b"]!.branch).toBe("feature-x");
    expect(byPath["run_d"]!.authorization).toBe("Bearer tr_preview_key");
    expect(byPath["run_d"]!.branch).toBe("feature-x");
  });

  it("masks taskContext.ctx inside an isolated scope (default)", () => {
    const fakeCtx = {
      run: { id: "run_parent", isTest: true },
      project: { ref: "proj_xyz" },
      environment: { slug: "preview" },
    } as any;

    taskContext.setGlobalTaskContext({ ctx: fakeCtx } as any);
    expect(taskContext.ctx).toBe(fakeCtx);

    const observed = sdkScope.withScope(
      { apiClientConfig: { accessToken: "x" }, inheritContext: false },
      () => taskContext.ctx
    );

    expect(observed).toBeUndefined();
  });

  it("exposes taskContext.ctx inside a scope when inheritContext is true", () => {
    const fakeCtx = {
      run: { id: "run_parent", isTest: true },
      project: { ref: "proj_xyz" },
      environment: { slug: "preview" },
    } as any;

    taskContext.setGlobalTaskContext({ ctx: fakeCtx } as any);

    const observed = sdkScope.withScope(
      { apiClientConfig: { accessToken: "x" }, inheritContext: true },
      () => taskContext.ctx
    );

    expect(observed).toBe(fakeCtx);
  });
});

describe("configure()", () => {
  beforeEach(() => {
    apiClientManager.disable();
  });

  afterEach(() => {
    apiClientManager.disable();
  });

  it("overrides previously-set configuration on a second call", async () => {
    configure({ accessToken: "tr_first" });
    expect(apiClientManager.accessToken).toBe("tr_first");

    configure({ accessToken: "tr_second", previewBranch: "branch-b" });
    expect(apiClientManager.accessToken).toBe("tr_second");
    expect(apiClientManager.branchName).toBe("branch-b");
  });
});

describe("auth.withAuth", () => {
  beforeEach(() => {
    apiClientManager.disable();
  });

  afterEach(() => {
    apiClientManager.disable();
  });

  it("inherits TRIGGER_SECRET_KEY from env when called with a partial config", async () => {
    vi.stubEnv("TRIGGER_SECRET_KEY", "tr_dev_env_token");

    let observed: string | undefined;
    await auth.withAuth({ baseURL: "https://override.example.com" }, async () => {
      observed = apiClientManager.accessToken;
    });

    // The scoped `inheritContext: true` path falls back to TRIGGER_SECRET_KEY
    // so callers can override only baseURL without re-passing the token.
    expect(observed).toBe("tr_dev_env_token");
    // baseURL override still applies.
    expect(
      await auth.withAuth(
        { baseURL: "https://override.example.com" },
        async () => apiClientManager.baseURL
      )
    ).toBe("https://override.example.com");
  });

  it("composes nested withAuth: outer-scope fields flow into the inner scope", async () => {
    vi.stubEnv("TRIGGER_SECRET_KEY", "tr_env_token");

    let observedBaseURL: string | undefined;
    let observedAuth: string | undefined;
    await auth.withAuth({ baseURL: "https://outer.example.com" }, async () => {
      await auth.withAuth({ accessToken: "tr_inner_token" }, async () => {
        observedBaseURL = apiClientManager.baseURL;
        observedAuth = apiClientManager.accessToken;
      });
    });

    expect(observedBaseURL).toBe("https://outer.example.com");
    expect(observedAuth).toBe("tr_inner_token");
  });

  it("does not stomp on a parallel withAuth call with a different config", async () => {
    configure({ accessToken: "tr_global" });

    const tokenA = "tr_concurrent_a";
    const tokenB = "tr_concurrent_b";

    const settle = {
      resolveA: () => {},
      resolveB: () => {},
    };
    const gateA = new Promise<void>((r) => (settle.resolveA = r));
    const gateB = new Promise<void>((r) => (settle.resolveB = r));

    const runA = auth.withAuth({ accessToken: tokenA }, async () => {
      // Suspend mid-scope so the parallel B scope opens while A is still pending.
      await gateA;
      return apiClientManager.accessToken;
    });

    const runB = auth.withAuth({ accessToken: tokenB }, async () => {
      // Open B's scope first, then unblock A. If withAuth used the old
      // mutate-and-restore pattern, A would observe tokenB or B's
      // .finally would restore the wrong "original".
      const seenInB = apiClientManager.accessToken;
      settle.resolveA();
      await gateB;
      return seenInB;
    });

    settle.resolveB(); // let B finish after A reads
    const [seenInA, seenInB] = await Promise.all([runA, runB]);

    expect(seenInA).toBe(tokenA);
    expect(seenInB).toBe(tokenB);
    // Global remains unchanged after both scopes exit.
    expect(apiClientManager.accessToken).toBe("tr_global");
  });
});
