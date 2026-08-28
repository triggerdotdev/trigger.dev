import { describe, expect, it } from "vitest";
import { renderReportAnsi, renderReportMarkdown } from "~/presenters/v3/reports/renderMarkdown";
import { buildReportLayout, REPORT_GLYPH } from "~/presenters/v3/reports/report-layout";
import { healthMessages } from "~/presenters/v3/reports/health/health-messages";
import {
  interpret,
  isPendingIncreasing,
  type HealthInput,
} from "~/presenters/v3/reports/health/health";

/** Golden A, degraded: env concurrency-limit saturation, backlog drains. */
const INPUT_A: HealthInput = {
  scope: "prod",
  period: "last 1h",
  baselineLabel: "vs your 7d normal",
  generatedAt: "2026-07-20T12:00:00.000Z",
  windowMinutes: 60,
  flowSource: "queue_metrics_v1",
  pending: { now: 1910, normal: 120, series: [120, 300, 700, 1200, 1600, 1910], estimated: false },
  startLatency: {
    p95Ms: 42000,
    normalP95Ms: 7000,
    series: [7000, 12000, 20000, 30000, 38000, 42000],
  },
  throughput: {
    finishedPerMin: 820,
    completedPerMin: 820,
    triggeredPerMin: 1150,
    normalTriggeredPerMin: 1100,
  },
  failures: { rate: 0.013, normalRate: 0.011, series: [0.011, 0.011, 0.012, 0.013] },
  duration: { p95Ms: 1200, normalP95Ms: 1180 },
  liveness: { telemetryAgeMs: 4000 },
  flowEvidence: {
    runningSeries: [60, 80, 90, 100, 100, 100, 100, 100, 100],
    envLimit: 100,
    throttledShare: 0.1,
    worstQueue: { name: "email-sends", share: 0.82 },
    dlqDelta: 0,
  },
};

/** Golden B, everything healthy. */
const INPUT_B: HealthInput = {
  scope: "prod",
  period: "last 1h",
  baselineLabel: "vs your 7d normal",
  generatedAt: "2026-07-20T12:00:00.000Z",
  windowMinutes: 60,
  flowSource: "queue_metrics_v1",
  pending: { now: 84, normal: 120, series: [110, 96, 88, 90, 84], estimated: false },
  startLatency: { p95Ms: 6000, normalP95Ms: 7000, series: [6500, 6200, 6000, 5900, 6000] },
  throughput: {
    finishedPerMin: 1000,
    completedPerMin: 1000,
    triggeredPerMin: 1000,
    normalTriggeredPerMin: 1000,
  },
  failures: { rate: 0.009, normalRate: 0.011, series: [0.01, 0.009, 0.009] },
  duration: { p95Ms: 1100, normalP95Ms: 1180 },
  liveness: { telemetryAgeMs: 2000 },
  flowEvidence: {
    runningSeries: [40, 45, 50, 48, 44],
    envLimit: 100,
    throttledShare: 0,
    worstQueue: null,
    dlqDelta: 0,
  },
};

describe("health cause tree (Golden A — env limit saturation)", () => {
  const vm = interpret(INPUT_A);
  const flow = vm.findings.find((f) => f.type === "flow")!;

  it("selects the env-limit-saturation cause + evidence", () => {
    expect(flow.reason).toBe("env_limit_saturation");
    expect(flow.severity).toBe("warn"); // crit raw, warn by the drainable policy
    expect(flow.anomalyWindow).toEqual({ minutes: 40, touchesEnd: true });
    expect(flow.attribution).toEqual({
      dim: "queue",
      key: "email-sends",
      share: 0.82,
      of: "pending",
    });
    expect(flow.exclusions).toEqual([]);
    expect(flow.observations).toEqual([
      { code: "not_workers_platform", evidence: { finishedPerMin: 820 } },
      { code: "nothing_dead_lettered", evidence: { dlq: 0 } },
    ]);
    expect(flow.read).toBe("saturation_chain");
    const concurrency = vm.metrics.find((m) => m.id === "concurrency")!;
    expect(concurrency.annotation).toEqual({ code: "pinned_minutes", value: 40 });
  });

  it("footer = raise the limit (self-serve) + docs + do-nothing (drains)", () => {
    expect(vm.footer).toEqual([
      { code: "raise_env_limit", link: "concurrency" },
      { code: "concurrency_docs", link: "concurrency" },
      { code: "do_nothing_drains", value: 2.3 },
    ]);
  });

  it("renders", () => {
    expect(renderReportMarkdown(vm)).toMatchInlineSnapshot(`
      "/report health        prod · last 1h · vs your 7d normal

      🟡 Flow slowing — at your env concurrency limit for the last 40 min

        concurrency     100/100           ▁▅▆█████   40 min at limit

        pending         1,910     ↑ 16×   ▁▁▂▃▅▅▇█   (normal ~120)

        start latency   p95 42s   ↑ 6×    ▁▁▂▄▆▆▇█   (normal ~7s)

        why:  82% of pending is email-sends
              runs are finishing at ~820/min
              nothing dead-lettered

      🟢 EXECUTION   runs are executing normally

      🟢 LIVENESS    fresh — telemetry current, updated 4s ago

        read: limit saturated → incoming work exceeds capacity → backlog grows
              runs are completing normally

      → Raise the env concurrency limit
        Read concurrency docs
        or do nothing — backlog drains in ~2.3 min once triggers ease"
    `);
  });
});

describe("health (Golden B — healthy)", () => {
  const vm = interpret(INPUT_B);

  it("all findings healthy, footer nothing-to-do", () => {
    expect(vm.summary.severity).toBe("ok");
    expect(vm.findings.map((f) => f.severity)).toEqual(["ok", "ok", "ok"]);
    expect(vm.footer).toEqual([{ code: "nothing_to_do" }]);
  });

  it("renders", () => {
    expect(renderReportMarkdown(vm)).toMatchInlineSnapshot(`
      "/report health        prod · last 1h · vs your 7d normal

      🟢 Flow healthy — starting normally

        start latency   p95 6s      → flat   ██▅▅▂▁▁▂   (normal ~7s)

        pending         84          → flat   ██▄▄▂▃▃▁   (normal ~120)

        throughput      0/min
          done          1,000/min
          triggered     1,000/min

      🟢 EXECUTION   runs are executing normally

      🟢 LIVENESS    fresh — telemetry current, updated 2s ago

        read: runs are starting on time
              runs are completing normally

      → nothing to do"
    `);
  });
});

describe("snapshot fallback path flags the estimated backlog trend", () => {
  // No queue-metrics evidence -> the backlog series is an estimate (finished-vs-triggered proxy).
  const snapshot: HealthInput = {
    ...INPUT_B,
    flowSource: "snapshot+runs",
    pending: { now: 6000, series: [1000, 3000, 6000], estimated: true }, // normal omitted on snapshot
    flowEvidence: {
      runningSeries: [],
      envLimit: 0,
      throttledShare: 0,
      worstQueue: null,
      dlqDelta: null,
    },
  };

  it("renders an estimated caveat on the proxy series, not a bare sparkline", () => {
    const vm = interpret(snapshot);
    expect(vm.findings.find((f) => f.type === "flow")!.reason).toBe("backlog");
    const md = renderReportMarkdown(vm);
    expect(md).toContain("(estimated from a proxy signal)");
  });
});

describe("liveness trust guard (telemetry freshness)", () => {
  it("stale telemetry forces execution unknown + crit summary + control-plane footer", () => {
    const stale: HealthInput = { ...INPUT_A, liveness: { telemetryAgeMs: 600_000 } };
    const vm = interpret(stale);
    const execution = vm.findings.find((f) => f.type === "execution")!;
    expect(execution.reason).toBe("unknown");
    expect(execution.read).toBe("data_stale");
    expect(vm.summary.severity).toBe("crit");
    expect(vm.footer).toEqual([{ code: "check_control_plane", link: "status" }]);
  });

  it("no freshness signal is 'unknown', NOT stale — it does not trust-guard execution", () => {
    const unknown: HealthInput = {
      ...INPUT_A,
      failures: { rate: 0.009, normalRate: 0.011, series: [0.009] },
      liveness: { telemetryAgeMs: null },
    };
    const vm = interpret(unknown);
    const execution = vm.findings.find((f) => f.type === "execution")!;
    const liveness = vm.findings.find((f) => f.type === "liveness")!;
    expect(liveness.reason).toBe("freshness_unknown");
    expect(liveness.severity).toBe("ok");
    expect(execution.reason).not.toBe("unknown");
  });

  it("no freshness signal is never TRUSTWORTHY, even though the human verdict stays neutral", () => {
    // The machine field must not claim trust it lacks: a health-recovery watch would fire off silence.
    const vm = interpret({ ...INPUT_B, liveness: { telemetryAgeMs: null } });
    expect(vm.summary.severity).toBe("ok");
    expect(vm.facts).toMatchObject({
      trustworthy: false,
      telemetry: "none",
      untrustworthyReason: "telemetry_absent",
    });
    expect(interpret({ ...INPUT_B, liveness: { telemetryAgeMs: 120_000 } }).facts).toMatchObject({
      trustworthy: true,
      telemetry: "lagging",
    });
  });

  it("a healthy but idle env (no telemetry signal) reads overall green, not yellow", () => {
    const vm = interpret({ ...INPUT_B, liveness: { telemetryAgeMs: null } });
    expect(vm.summary.severity).toBe("ok");
    expect(vm.findings.find((f) => f.type === "liveness")!.reason).toBe("freshness_unknown");
    const md = renderReportMarkdown(vm);
    expect(md).toContain("⚪");
    expect(md).not.toContain("🟡");
  });
});

describe("isPendingIncreasing", () => {
  it("detects a positive trend", () => {
    expect(isPendingIncreasing([120, 300, 700, 1200, 1600, 1910])).toBe(true);
    expect(isPendingIncreasing([110, 96, 88, 90, 84])).toBe(false);
  });
});

/** Fixed-priority cause tree: the first discriminator that fires wins. */
describe("flow cause tree — cause selection per discriminator", () => {
  const withFlow = (
    flowEvidence: Partial<HealthInput["flowEvidence"]>,
    throughput?: Partial<HealthInput["throughput"]>
  ): HealthInput => ({
    ...INPUT_A,
    throughput: { ...INPUT_A.throughput, ...throughput },
    flowEvidence: { ...INPUT_A.flowEvidence, ...flowEvidence },
  });

  const flowReason = (input: HealthInput) =>
    interpret(input).findings.find((f) => f.type === "flow")!.reason;

  it("env_limit_saturation — concurrency pinned at the env limit", () => {
    expect(flowReason(INPUT_A)).toBe("env_limit_saturation");
  });

  it("dequeue_stall — capacity idle while the backlog grows", () => {
    expect(flowReason(withFlow({ runningSeries: Array(9).fill(10) }))).toBe("dequeue_stall");
  });

  it("queue_limit_throttling — throttled, but the env limit is not the bottleneck", () => {
    expect(flowReason(withFlow({ runningSeries: Array(9).fill(50), throttledShare: 0.5 }))).toBe(
      "queue_limit_throttling"
    );
  });

  it("selects queue throttling over dequeue stall when both shapes match", () => {
    expect(flowReason(withFlow({ runningSeries: Array(9).fill(10), throttledShare: 0.5 }))).toBe(
      "queue_limit_throttling"
    );
  });

  it("trigger_spike — triggers >= 3x the normal rate", () => {
    expect(
      flowReason(
        withFlow(
          { runningSeries: Array(9).fill(50), throttledShare: 0 },
          { triggeredPerMin: 3300, normalTriggeredPerMin: 1100 }
        )
      )
    ).toBe("trigger_spike");
  });

  it("trigger_surge — new volume with no baseline (multiplier can't be computed)", () => {
    // A zero baseline makes the multiplier meaningless, so an absolute rate selects new volume.
    const input = withFlow(
      { runningSeries: Array(9).fill(50), throttledShare: 0 },
      { triggeredPerMin: 5000, normalTriggeredPerMin: 0 }
    );
    expect(flowReason(input)).toBe("trigger_surge");
    const triggered = interpret(input).metrics.find((m) => m.id === "triggered")!;
    expect(triggered.annotation).toEqual({ code: "surge_rate", value: 5000 });
  });

  it("does not select trigger_spike when completions keep pace and pending falls", () => {
    const input: HealthInput = {
      ...INPUT_A,
      pending: { now: 400, normal: 1000, series: [500, 450, 400], estimated: false },
      throughput: {
        finishedPerMin: 3300,
        completedPerMin: 3300,
        triggeredPerMin: 3300,
        normalTriggeredPerMin: 1100,
      },
      flowEvidence: {
        ...INPUT_A.flowEvidence,
        runningSeries: Array(9).fill(50),
        throttledShare: 0,
      },
    };
    expect(flowReason(input)).not.toBe("trigger_spike");
    expect(flowReason(input)).toBe("start_latency");
  });

  it("does not select trigger_surge when new volume is draining", () => {
    const input: HealthInput = {
      ...INPUT_A,
      pending: { now: 400, normal: 1000, series: [500, 450, 400], estimated: false },
      throughput: {
        finishedPerMin: 6000,
        completedPerMin: 6000,
        triggeredPerMin: 5000,
        normalTriggeredPerMin: 0,
      },
      flowEvidence: {
        ...INPUT_A.flowEvidence,
        runningSeries: Array(9).fill(50),
        throttledShare: 0,
      },
    };
    expect(flowReason(input)).not.toBe("trigger_surge");
  });

  it("fallback — degraded with no discriminator -> v1 symptom (start latency)", () => {
    expect(flowReason(withFlow({ runningSeries: Array(9).fill(50), throttledShare: 0 }))).toBe(
      "start_latency"
    );
  });
});

describe("env_limit_saturation read does not claim a start lag that isn't there", () => {
  // Saturation can grow a backlog before p95 crosses its threshold, so the read must not assert "starts lag".
  const input: HealthInput = {
    ...INPUT_A,
    startLatency: { p95Ms: 6000, normalP95Ms: 7000, series: [6000, 6100, 6000, 5900, 6000] },
    flowEvidence: { ...INPUT_A.flowEvidence, runningSeries: Array(9).fill(100) },
  };
  const vm = interpret(input);
  const flow = vm.findings.find((f) => f.type === "flow")!;

  it("still selects env_limit_saturation with a latency-free read", () => {
    expect(flow.reason).toBe("env_limit_saturation");
    expect(flow.read).toBe("saturation_chain");
    expect(vm.metrics.find((m) => m.id === "start_latency_p95")!.severity).toBe("ok");
    const md = renderReportMarkdown(vm);
    expect(md).toContain("incoming work exceeds capacity");
    expect(md).not.toContain("starts lag");
  });
});

describe("trigger spike does not exonerate user code", () => {
  const spike = interpret({
    ...INPUT_A,
    throughput: {
      finishedPerMin: 820,
      completedPerMin: 820,
      triggeredPerMin: 3300,
      normalTriggeredPerMin: 1100,
    },
    flowEvidence: { ...INPUT_A.flowEvidence, runningSeries: Array(9).fill(50), throttledShare: 0 },
  });

  it("reports execution is healthy but never claims 'NOT a code problem'", () => {
    expect(spike.findings.find((f) => f.type === "flow")!.reason).toBe("trigger_spike");
    const md = renderReportMarkdown(spike);
    expect(md).toContain("runs that start are completing normally");
    expect(md).not.toContain("NOT a code problem");
  });

  it("dequeue_stall (platform-side) still reads 'NOT a code problem'", () => {
    const stall = interpret({
      ...INPUT_A,
      flowEvidence: { ...INPUT_A.flowEvidence, runningSeries: Array(9).fill(10) },
    });
    expect(stall.findings.find((f) => f.type === "flow")!.reason).toBe("dequeue_stall");
    expect(renderReportMarkdown(stall)).toContain("NOT a code problem");
  });
});

describe("ANSI render (terminal)", () => {
  const ansi = renderReportAnsi(interpret(INPUT_A));

  it("uses glyphs + ANSI colour, never the markdown status emoji", () => {
    expect(ansi).toMatch(/\x1b\[\d+m/); // an ANSI SGR colour code
    expect(ansi).toMatch(/[✓⚠✕]/); // severity glyphs (not emoji)
    expect(ansi).not.toMatch(/[🟢🟡🔴]/u);
  });
});

describe("exclusions are proven, not assumed", () => {
  const withFlow = (
    flowEvidence: Partial<HealthInput["flowEvidence"]>,
    over: Partial<HealthInput> = {}
  ): HealthInput => ({
    ...INPUT_A,
    ...over,
    flowEvidence: { ...INPUT_A.flowEvidence, ...flowEvidence },
  });
  const exclusionCodes = (input: HealthInput) =>
    (interpret(input).findings.find((f) => f.type === "flow")!.exclusions ?? []).map((e) => e.code);
  const observationCodes = (input: HealthInput) =>
    (interpret(input).findings.find((f) => f.type === "flow")!.observations ?? []).map(
      (o) => o.code
    );

  it("dequeue_stall claims not-your-code AND not-your-config (both proven: healthy exec, no pin, no throttle)", () => {
    const codes = exclusionCodes(withFlow({ runningSeries: Array(9).fill(10) }));
    expect(codes).toContain("not_your_code");
    expect(codes).toContain("not_your_config");
  });

  it("trigger_spike observes healthy execution without ruling out user code", () => {
    const healthyInput = withFlow(
      { runningSeries: Array(9).fill(50), throttledShare: 0 },
      {
        throughput: {
          finishedPerMin: 820,
          completedPerMin: 820,
          triggeredPerMin: 3300,
          normalTriggeredPerMin: 1100,
        },
      }
    );
    expect(observationCodes(healthyInput)).toContain("execution_healthy");
    expect(exclusionCodes(healthyInput)).not.toContain("not_your_code");

    const degradedInput = withFlow(
      { runningSeries: Array(9).fill(50), throttledShare: 0 },
      {
        throughput: {
          finishedPerMin: 820,
          completedPerMin: 820,
          triggeredPerMin: 3300,
          normalTriggeredPerMin: 1100,
        },
        failures: { rate: 0.2, normalRate: 0.01, series: [0.2] },
      }
    );
    expect(observationCodes(degradedInput)).not.toContain("execution_healthy");
  });
});

describe("stale-telemetry trust guard covers flow (not just execution)", () => {
  const stale = interpret({ ...INPUT_A, liveness: { telemetryAgeMs: 600_000 } });
  const flow = stale.findings.find((f) => f.type === "flow")!;
  const execution = stale.findings.find((f) => f.type === "execution")!;

  it("marks flow unknown + crit and strips its action / attribution / exclusions / anomaly window", () => {
    expect(flow.reason).toBe("unknown");
    expect(flow.severity).toBe("crit");
    expect(flow.recommendation).toBeUndefined();
    expect(flow.attribution).toBeUndefined();
    expect(flow.exclusions).toBeUndefined();
    expect(flow.observations).toBeUndefined();
    expect(flow.anomalyWindow).toBeUndefined();
  });

  it("marks execution unknown + crit too", () => {
    expect(execution.reason).toBe("unknown");
    expect(execution.severity).toBe("crit");
  });

  it("strips stale-derived metric annotations so format=json can't leak them", () => {
    expect(stale.metrics.every((m) => m.annotation === undefined)).toBe(true);
  });

  it("renders both sections red as unknown, with no stale causal verdict", () => {
    const md = renderReportMarkdown(stale);
    expect(md).toContain("🔴 Flow unknown — data stale");
    expect(md).toContain("🔴 EXECUTION   execution can't be assessed");
    expect(md).toContain("🚩 stale data");
    expect(md).not.toContain("(last 40 min)");
  });

  it("drops the CH-derived link from the VM when telemetry is stale", () => {
    expect(stale.links.map((l) => l.key)).not.toContain("concurrency");
  });

  it("flags the structured facts informational-only so an agent won't act on stale numbers", () => {
    expect(stale.facts).toMatchObject({
      trustworthy: false,
      telemetry: "stale",
      untrustworthyReason: "telemetry_stale",
    });
    expect(interpret(INPUT_A).facts).toMatchObject({ trustworthy: true, telemetry: "fresh" });
  });
});

describe("freshness unknown is distinct from lagging", () => {
  it("renders the liveness section as 'freshness unknown', not 'data lagging'", () => {
    const md = renderReportMarkdown(interpret({ ...INPUT_A, liveness: { telemetryAgeMs: null } }));
    expect(md).toContain("⚪ LIVENESS    freshness unknown");
    expect(md).not.toContain("data lagging");
  });

  it("does not change the flow severity policy (drainable crit still downgrades to warn)", () => {
    const fresh = interpret(INPUT_A).findings.find((f) => f.type === "flow")!;
    const unknown = interpret({ ...INPUT_A, liveness: { telemetryAgeMs: null } }).findings.find(
      (f) => f.type === "flow"
    )!;
    expect(unknown.severity).toBe(fresh.severity);
  });

  it("marks the liveness metric availability 'unknown' so value 0 isn't read as fresh", () => {
    const unknown = interpret({ ...INPUT_A, liveness: { telemetryAgeMs: null } });
    const metric = unknown.metrics.find((m) => m.id === "liveness")!;
    expect(metric.availability).toBe("unknown");
    expect(interpret(INPUT_A).metrics.find((m) => m.id === "liveness")!.availability).toBe(
      "measured"
    );
  });
});

describe("start latency with no measurement", () => {
  const unknownInput: HealthInput = {
    ...INPUT_B,
    startLatency: { p95Ms: 0, normalP95Ms: undefined, series: [], availability: "unknown" },
  };

  it("marks the metric 'unknown' and doesn't classify it", () => {
    const metric = interpret(unknownInput).metrics.find((m) => m.id === "start_latency_p95")!;
    expect(metric.availability).toBe("unknown");
    expect(metric.severity).toBe("ok");
    expect(metric.normal).toBeUndefined();
    expect(metric.series).toBeUndefined(); // no sparkline for a placeholder
  });

  it("renders 'unknown', never a confident 0ms", () => {
    const md = renderReportMarkdown(interpret(unknownInput));
    expect(md).toMatch(/start latency\s+unknown/);
    expect(md).not.toMatch(/start latency\s+p95 0ms/);
  });

  it("keeps a genuine 0 a measured 0ms", () => {
    const measured = interpret({
      ...INPUT_B,
      startLatency: { p95Ms: 0, normalP95Ms: 7000, series: [0, 0], availability: "measured" },
    });
    const metric = measured.metrics.find((m) => m.id === "start_latency_p95")!;
    expect(metric.availability).toBe("measured");
    expect(renderReportMarkdown(measured)).toMatch(/start latency\s+p95 0ms/);
  });
});

describe("zero baseline is not a false green (absolute floors)", () => {
  it("pending spiking from a 0 baseline is not healthy", () => {
    const vm = interpret({
      ...INPUT_B,
      pending: { now: 6000, normal: 0, series: [0, 100, 6000], estimated: false },
    });
    expect(vm.findings.find((f) => f.type === "flow")!.severity).not.toBe("ok");
  });

  it("failures spiking from a 0% baseline is not healthy", () => {
    const vm = interpret({ ...INPUT_B, failures: { rate: 0.1, normalRate: 0, series: [0.1] } });
    expect(vm.findings.find((f) => f.type === "execution")!.severity).not.toBe("ok");
  });
});

describe("an unmeasurable backlog is not a healthy backlog", () => {
  // The depth couldn't be measured, so `now` is a placeholder, not a reading.
  const unmeasured: HealthInput = {
    ...INPUT_B,
    pending: { now: 0, series: [], estimated: true, availability: "unknown" },
  };

  it("reports flow unassessable instead of healthy, with no action off the placeholder", () => {
    const vm = interpret(unmeasured);
    const flow = vm.findings.find((f) => f.type === "flow")!;
    expect(flow.reason).toBe("flow_unmeasured");
    expect(flow.recommendation).toBeUndefined();
    expect(flow.attribution).toBeUndefined();
    expect(vm.footer).toEqual([{ code: "nothing_to_do" }]);
    expect(vm.facts).toMatchObject({ trustworthy: false, untrustworthyReason: "flow_unmeasured" });
  });

  it("does not classify the placeholder depth or offer a drain ETA", () => {
    const vm = interpret({
      ...unmeasured,
      // A placeholder that would cross the crit floor if it were classified.
      pending: { now: 9000, series: [], estimated: true, availability: "unknown" },
    });
    const pending = vm.metrics.find((m) => m.id === "pending")!;
    expect(pending.availability).toBe("unknown");
    expect(pending.severity).toBe("ok");
    expect(vm.footer.map((f) => f.code)).not.toContain("do_nothing_drains");
  });

  it("renders the flow section with the neutral marker and no facts off the placeholder", () => {
    const md = renderReportMarkdown(interpret(unmeasured));
    expect(md).toContain("Flow unknown — queue depth unavailable");
    expect(md).not.toContain("pending 0");
    expect(md).not.toContain("🟢 Flow healthy");
  });
});

describe("an unmeasured input does not silence a measured finding", () => {
  // The depth is a placeholder, but start latency is measured off `runs` and is 43x its normal.
  const unmeasuredDepthCritLatency: HealthInput = {
    ...INPUT_B,
    pending: { now: 0, series: [], estimated: true, availability: "unknown" },
    startLatency: {
      p95Ms: 300_000,
      normalP95Ms: 7000,
      series: [7000, 40_000, 120_000, 240_000, 300_000],
    },
  };

  /** The two surfaces of one report: what `format=json` claims, and what the layout both text and card render says. */
  function surfaces(input: HealthInput) {
    const vm = interpret(input);
    return { vm, layout: buildReportLayout(vm, healthMessages), md: renderReportMarkdown(vm) };
  }

  it("the rendered verdict and the JSON severity say the same thing", () => {
    const { vm, layout } = surfaces(unmeasuredDepthCritLatency);

    expect(vm.summary.severity).toBe("crit");
    // The property: neither surface may be calmer than the other.
    expect(layout.headline.severity).toBe(vm.summary.severity);
    expect(layout.headline.tone).toBe(vm.summary.severity);
    expect(layout.headline.glyph).toBe(REPORT_GLYPH.crit);
  });

  it("keeps the measured evidence that earned the severity in the text", () => {
    const { layout, md } = surfaces(unmeasuredDepthCritLatency);

    expect(layout.hero?.expanded).toBe(true);
    expect(layout.hero?.metrics.map((m) => m.id)).toContain("start_latency_p95");
    expect(md).toContain("start latency");
    expect(md).toContain("p95 5m");
    expect(layout.reads.length).toBeGreaterThan(0);
    expect(md).not.toContain("→ nothing to do");
  });

  it("still refuses to conclude anything about the depth it could not measure", () => {
    const { vm, md } = surfaces(unmeasuredDepthCritLatency);
    const flow = vm.findings.find((f) => f.type === "flow")!;

    expect(vm.metrics.find((m) => m.id === "pending")!.availability).toBe("unknown");
    expect(vm.metrics.find((m) => m.id === "pending")!.severity).toBe("ok");
    // No cause, attribution or drain ETA may be built on the placeholder.
    expect(flow.attribution).toBeUndefined();
    expect(flow.anomalyWindow).toBeUndefined();
    expect(vm.footer.map((f) => f.code)).not.toContain("do_nothing_drains");
    expect(md).not.toContain("pending 0");
    expect(vm.facts).toMatchObject({ trustworthy: false, untrustworthyReason: "flow_unmeasured" });
  });

  it("still says 'we can't say' when the measured inputs are the ones with nothing to report", () => {
    const { vm, layout } = surfaces({
      ...INPUT_B,
      pending: { now: 0, series: [], estimated: true, availability: "unknown" },
    });

    expect(vm.summary.severity).toBe("ok");
    expect(layout.headline.tone).toBe("neutral");
    expect(layout.headline.phrase).toBe("Flow unknown — queue depth unavailable");
  });
});

describe("gappy telemetry cannot read as a full window", () => {
  // 60 expected buckets at a 1-minute cadence, but only 2 arrived, both pinned at the limit.
  const gappy: HealthInput = {
    ...INPUT_A,
    flowEvidence: {
      ...INPUT_A.flowEvidence,
      runningSeries: [100, 100],
      runningBucketsMs: [Date.parse("2026-07-20T11:58:00Z"), Date.parse("2026-07-20T11:59:00Z")],
      sampling: { bucketMinutes: 1, expectedBuckets: 60 },
    },
  };

  it("does not attribute a concurrency cause off 2 of 60 expected buckets", () => {
    const vm = interpret(gappy);
    const flow = vm.findings.find((f) => f.type === "flow")!;
    expect(flow.reason).not.toBe("env_limit_saturation");
    expect(flow.reason).not.toBe("dequeue_stall");
    expect(flow.anomalyWindow).toBeUndefined();
    const concurrency = vm.metrics.find((m) => m.id === "concurrency")!;
    expect(concurrency.annotation).toBeUndefined();
    expect(renderReportMarkdown(vm)).not.toContain("pinned 60");
  });

  it("counts a duration at the real cadence, and a gap breaks the run", () => {
    // One bucket is missing in the middle, so the trailing pinned run is 3 buckets, not the whole window.
    const cadence = 60_000;
    const start = Date.parse("2026-07-20T11:00:00Z");
    // 34 of 60 buckets pinned, over the pinned-share threshold; the rest busy but not pinned.
    const running = Array.from({ length: 60 }, (_, i) => (i >= 26 ? 100 : 60));
    const timestamps = Array.from({ length: 60 }, (_, i) => start + i * cadence);
    // Drop bucket 57's continuity by pushing it 10 minutes later, making a gap.
    for (let i = 57; i < 60; i++) timestamps[i] += 10 * cadence;
    const vm = interpret({
      ...INPUT_A,
      flowEvidence: {
        ...INPUT_A.flowEvidence,
        runningSeries: running,
        runningBucketsMs: timestamps,
        sampling: { bucketMinutes: 1, expectedBuckets: 60 },
      },
    });
    const flow = vm.findings.find((f) => f.type === "flow")!;
    expect(flow.reason).toBe("env_limit_saturation");
    expect(flow.anomalyWindow).toEqual({ minutes: 3, touchesEnd: true });
  });
});

describe("drain math counts every terminal run, not only completions", () => {
  it("80 completed + 20 failed against 100 triggered/min reads as stable, not a deficit", () => {
    const vm = interpret({
      ...INPUT_B,
      throughput: {
        finishedPerMin: 100, // 80 completed + 20 failed all left the queue
        completedPerMin: 80,
        triggeredPerMin: 100,
        normalTriggeredPerMin: 100,
      },
    });
    const throughput = vm.metrics.find((m) => m.id === "throughput")!;
    expect(throughput.value).toBe(0); // net, not −20/min
    expect(throughput.severity).toBe("ok");
    expect(vm.findings.find((f) => f.type === "flow")!.severity).toBe("ok");
  });
});
