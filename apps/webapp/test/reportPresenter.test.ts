import { describe, expect, it } from "vitest";
import { ReportPresenter } from "~/presenters/v3/reports/ReportPresenter.server";
import { type ReportLoader } from "~/presenters/v3/reports/report-registry";
import { type ReportViewModel } from "~/presenters/v3/reports/report-view-model";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";

/** The presenter only ever reads `environment.id` for its single-flight key. */
function env(id: string): AuthenticatedEnvironment {
  return { id } as unknown as AuthenticatedEnvironment;
}

function viewModel(title: string): ReportViewModel {
  return {
    title,
    scope: "prod",
    period: "last 1h",
    generatedAt: "2026-01-01T00:00:00.000Z",
    windowMinutes: 60,
    summary: { severity: "ok", statements: [] },
    findings: [],
    metrics: [],
    facts: {},
    links: [],
    footer: [],
  };
}

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A loader whose `load` blocks on a gate, so concurrency is observable. */
function gatedRegistry(): {
  registry: Record<string, ReportLoader<unknown>>;
  loadCalls: () => number;
  gate: () => Deferred;
  nextGate: () => void;
} {
  let loads = 0;
  let current = deferred();

  const registry: Record<string, ReportLoader<unknown>> = {
    gated: {
      tables: ["runs"],
      load: async () => {
        loads++;
        await current.promise;
        return {};
      },
      interpret: () => viewModel("gated"),
    } as ReportLoader<unknown>,
  };

  return {
    registry,
    loadCalls: () => loads,
    gate: () => current,
    nextGate: () => {
      current = deferred();
    },
  };
}

describe("ReportPresenter — single-flight", () => {
  it("collapses concurrent identical calls into one load", async () => {
    const { registry, loadCalls, gate } = gatedRegistry();
    const presenter = new ReportPresenter(registry);

    const a = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    const b = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    const c = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });

    gate().resolve();
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    expect(loadCalls()).toBe(1);
    // Same promise, so literally the same object — not just an equal one.
    expect(ra).toBe(rb);
    expect(rb).toBe(rc);
  });

  it("does not collapse calls that differ by period or environment", async () => {
    const { registry, loadCalls, gate } = gatedRegistry();
    const presenter = new ReportPresenter(registry);

    const calls = [
      presenter.call({ environment: env("env_1"), key: "gated", period: "1h" }),
      presenter.call({ environment: env("env_1"), key: "gated", period: "24h" }),
      presenter.call({ environment: env("env_2"), key: "gated", period: "1h" }),
    ];

    gate().resolve();
    await Promise.all(calls);

    expect(loadCalls()).toBe(3);
  });

  it("runs a fresh load once the previous one has settled", async () => {
    const { registry, loadCalls, gate, nextGate } = gatedRegistry();
    const presenter = new ReportPresenter(registry);

    const first = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    gate().resolve();
    await first;

    nextGate();
    const second = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    gate().resolve();
    await second;

    expect(loadCalls()).toBe(2);
  });

  it("evicts a rejected in-flight entry so the next call retries", async () => {
    const { registry, loadCalls, gate, nextGate } = gatedRegistry();
    const presenter = new ReportPresenter(registry);

    const failing = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    gate().reject(new Error("clickhouse exploded"));
    await expect(failing).rejects.toThrow("clickhouse exploded");
    expect(loadCalls()).toBe(1);

    // A cached rejected promise would re-throw here without ever calling `load` again.
    nextGate();
    const retried = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    gate().resolve();

    await expect(retried).resolves.toMatchObject({ title: "gated" });
    expect(loadCalls()).toBe(2);
  });

  it("returns undefined for an unknown key without touching the registry", async () => {
    const { registry, loadCalls } = gatedRegistry();
    const presenter = new ReportPresenter(registry);

    await expect(
      presenter.call({ environment: env("env_1"), key: "nope" })
    ).resolves.toBeUndefined();
    // `Object.hasOwn`, not `in` — a prototype key must not resolve to a loader.
    await expect(
      presenter.call({ environment: env("env_1"), key: "toString" })
    ).resolves.toBeUndefined();
    expect(loadCalls()).toBe(0);
  });
});
