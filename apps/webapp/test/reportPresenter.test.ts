import { describe, expect, it } from "vitest";
import { HEALTH_THRESHOLDS } from "~/presenters/v3/reports/health/health-core";
import {
  createReportCache,
  ReportPresenter,
  REPORT_CACHE_TTL_MS,
} from "~/presenters/v3/reports/ReportPresenter.server";
import { type ReportLoader } from "~/presenters/v3/reports/report-registry";
import { type ReportViewModel } from "~/presenters/v3/reports/report-view-model";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";

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

describe("ReportPresenter — single-flight + TTL cache", () => {
  it("collapses concurrent identical calls into one load", async () => {
    const { registry, loadCalls, gate } = gatedRegistry();
    const presenter = new ReportPresenter(registry, createReportCache());

    const a = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    const b = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    const c = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });

    gate().resolve();
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    expect(loadCalls()).toBe(1);
    expect(ra).toBe(rb);
    expect(rb).toBe(rc);
  });

  it("does not collapse calls that differ by period or environment", async () => {
    const { registry, loadCalls, gate } = gatedRegistry();
    const presenter = new ReportPresenter(registry, createReportCache());

    const calls = [
      presenter.call({ environment: env("env_1"), key: "gated", period: "1h" }),
      presenter.call({ environment: env("env_1"), key: "gated", period: "24h" }),
      presenter.call({ environment: env("env_2"), key: "gated", period: "1h" }),
    ];

    gate().resolve();
    await Promise.all(calls);

    expect(loadCalls()).toBe(3);
  });

  it("runs a fresh load once the cached report has expired", async () => {
    const { registry, loadCalls, gate, nextGate } = gatedRegistry();
    // 1ms window, so the second call is past it without waiting on the real TTL.
    const presenter = new ReportPresenter(registry, createReportCache(1));

    const first = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    gate().resolve();
    await first;

    await new Promise((resolve) => setTimeout(resolve, 20));

    nextGate();
    const second = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    gate().resolve();
    await second;

    expect(loadCalls()).toBe(2);
  });

  it("evicts a rejected in-flight entry so the next call retries", async () => {
    const { registry, loadCalls, gate, nextGate } = gatedRegistry();
    const presenter = new ReportPresenter(registry, createReportCache());

    const failing = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    gate().reject(new Error("clickhouse exploded"));
    await expect(failing).rejects.toThrow("clickhouse exploded");
    expect(loadCalls()).toBe(1);

    nextGate();
    const retried = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    gate().resolve();

    await expect(retried).resolves.toMatchObject({ title: "gated" });
    expect(loadCalls()).toBe(2);
  });

  it("serves a settled report from the cache instead of loading again", async () => {
    const { registry, loadCalls, gate, nextGate } = gatedRegistry();
    const presenter = new ReportPresenter(registry, createReportCache());

    const first = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    gate().resolve();
    await first;

    // A second gate that is never opened: if this call loaded, it would hang.
    nextGate();
    const second = await presenter.call({
      environment: env("env_1"),
      key: "gated",
      period: "1h",
    });

    expect(loadCalls()).toBe(1);
    expect(second).toMatchObject({ title: "gated" });
  });

  it("never serves one environment's cached report to another", async () => {
    const { registry, loadCalls, gate, nextGate } = gatedRegistry();
    const presenter = new ReportPresenter(registry, createReportCache());

    const first = presenter.call({ environment: env("env_1"), key: "gated", period: "1h" });
    gate().resolve();
    await first;

    nextGate();
    const other = presenter.call({ environment: env("env_2"), key: "gated", period: "1h" });
    gate().resolve();
    await other;

    expect(loadCalls()).toBe(2);
  });

  it("returns undefined for an unknown key without touching the registry", async () => {
    const { registry, loadCalls } = gatedRegistry();
    const presenter = new ReportPresenter(registry, createReportCache());

    await expect(
      presenter.call({ environment: env("env_1"), key: "nope" })
    ).resolves.toBeUndefined();
    // `Object.hasOwn`, not `in`: a prototype key must not resolve to a loader.
    await expect(
      presenter.call({ environment: env("env_1"), key: "toString" })
    ).resolves.toBeUndefined();
    expect(loadCalls()).toBe(0);
  });

  // A report cached longer than the liveness fresh window could render "fresh" while its
  // telemetry is already stale.
  it("never caches a report past the liveness fresh window", () => {
    expect(REPORT_CACHE_TTL_MS).toBeLessThanOrEqual(HEALTH_THRESHOLDS.liveness.freshMs);
  });
});
