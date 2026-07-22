import { describe, expect, it } from "vitest";
import { renderReportAnsi, renderReportMarkdown } from "~/presenters/v3/reports/renderMarkdown";
import {
  interpret,
  isPendingIncreasing,
  type HealthInput,
} from "~/presenters/v3/reports/health/health";

/** Golden A — degraded: env concurrency-limit saturation, backlog drains. */
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
  throughput: { donePerMin: 820, triggeredPerMin: 1150, normalTriggeredPerMin: 1100 },
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

/** Golden B — everything healthy. */
const INPUT_B: HealthInput = {
  scope: "prod",
  period: "last 1h",
  baselineLabel: "vs your 7d normal",
  generatedAt: "2026-07-20T12:00:00.000Z",
  windowMinutes: 60,
  flowSource: "queue_metrics_v1",
  pending: { now: 84, normal: 120, series: [110, 96, 88, 90, 84], estimated: false },
  startLatency: { p95Ms: 6000, normalP95Ms: 7000, series: [6500, 6200, 6000, 5900, 6000] },
  throughput: { donePerMin: 1000, triggeredPerMin: 1000, normalTriggeredPerMin: 1000 },
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
    expect(flow.exclusions).toEqual([]); // env-limit saturation rules nothing out...
    expect(flow.observations).toEqual([
      // ...it states supporting facts instead.
      { code: "not_workers_platform", evidence: { donePerMin: 820 } },
      { code: "nothing_dead_lettered", evidence: { dlq: 0 } },
    ]);
    expect(flow.read).toBe("saturation_chain");
    const concurrency = vm.metrics.find((m) => m.id === "concurrency")!;
    expect(concurrency.annotation).toEqual({ code: "pinned_minutes", value: 40 });
  });

  it("footer = raise limit + do-nothing (drains)", () => {
    expect(vm.footer).toEqual([
      { code: "raise_env_limit", link: "concurrency" },
      { code: "do_nothing_drains", value: 2.3 },
    ]);
  });

  it("renders", () => {
    expect(renderReportMarkdown(vm)).toMatchInlineSnapshot(`
      "/report health        prod · last 1h · vs your 7d normal

      🟡 Flow slowing  ·  🟢 Execution healthy  ·  🟢 data fresh

      FLOW        🟡 at your env concurrency limit (last 40 min)

        concurrency     100/100           ▁▅▆█████   pinned 40 of last 60 min

        pending         1,910     ↑ 16×   ▁▁▂▃▅▅▇█   (normal ~120)

        start latency   p95 42s   ↑ 6×    ▁▁▂▄▆▆▇█   (normal ~7s)

        worst queue     email-sends — 82% of pending

        read: limit saturated → incoming work exceeds capacity → backlog grows
              runs are completing at ~820/min
              nothing dead-lettered

      EXECUTION   🟢 the runs that DO start are fine

        failures 1.3% (normal ~1.1%) · durations normal
        read: runs are completing normally

      LIVENESS    🟢 fresh — telemetry current, updated 4s ago

      → Raise the env concurrency limit
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

      🟢 Flow healthy  ·  🟢 Execution healthy  ·  🟢 data fresh

      FLOW        🟢 starting normally — pending 84 (normal ~120) · starts p95 6s

      EXECUTION   🟢 completing normally — failures 0.9% (normal ~1.1%) · durations normal

      LIVENESS    🟢 fresh — telemetry current, updated 2s ago

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

  it("renders an (estimated) caveat on the proxy series, not a bare sparkline", () => {
    const vm = interpret(snapshot);
    expect(vm.findings.find((f) => f.type === "flow")!.reason).toBe("backlog");
    const md = renderReportMarkdown(vm);
    expect(md).toContain("(estimated)"); // the human surface signals the trend is a proxy
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
    // #6: footer points at the pipeline, not "raise the env limit" off stale data.
    expect(vm.footer).toEqual([{ code: "check_control_plane", link: "status" }]);
  });

  it("no freshness signal is 'unknown', NOT stale — it does not trust-guard execution", () => {
    const unknown: HealthInput = {
      ...INPUT_A,
      // healthy execution so we can see the guard did NOT fire.
      failures: { rate: 0.009, normalRate: 0.011, series: [0.009] },
      liveness: { telemetryAgeMs: null },
    };
    const vm = interpret(unknown);
    const execution = vm.findings.find((f) => f.type === "execution")!;
    const liveness = vm.findings.find((f) => f.type === "liveness")!;
    expect(liveness.reason).toBe("freshness_unknown");
    expect(liveness.severity).toBe("ok"); // no signal is NEUTRAL, not a warning
    expect(execution.reason).not.toBe("unknown");
  });

  it("a healthy but idle env (no telemetry signal) reads overall green, not yellow", () => {
    // Golden B is all-healthy; drop its telemetry signal -> the verdict must stay ok, since
    // "freshness unknown" is neutral and must not drag a fine env into a yellow report.
    const vm = interpret({ ...INPUT_B, liveness: { telemetryAgeMs: null } });
    expect(vm.summary.severity).toBe("ok");
    expect(vm.findings.find((f) => f.type === "liveness")!.reason).toBe("freshness_unknown");
    // ...but the marker is NEUTRAL (⚪), not a confident green — the state is genuinely unknown.
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

/**
 * Fixed-priority cause tree: the first discriminator that fires wins. Each case starts
 * from Golden A and overrides ONLY flow evidence so the intended discriminator matches
 * (Golden A itself covers env_limit_saturation).
 */
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
    // running far below the limit (0.1) with a rising backlog + elevated latency.
    expect(flowReason(withFlow({ runningSeries: Array(9).fill(10) }))).toBe("dequeue_stall");
  });

  it("queue_limit_throttling — throttled, but the env limit is not the bottleneck", () => {
    expect(flowReason(withFlow({ runningSeries: Array(9).fill(50), throttledShare: 0.5 }))).toBe(
      "queue_limit_throttling"
    );
  });

  it("selects queue throttling over dequeue stall when both shapes match", () => {
    // low running (would look like a stall) BUT the queue is throttling — the known config
    // bottleneck must win, not "it's on our side".
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
    // normal 0 makes a multiplier meaningless, so an absolute rate selects "new volume"
    // instead of dropping to the v1 fallback (a spike from a zero baseline was invisible before).
    const input = withFlow(
      { runningSeries: Array(9).fill(50), throttledShare: 0 },
      { triggeredPerMin: 5000, normalTriggeredPerMin: 0 }
    );
    expect(flowReason(input)).toBe("trigger_surge");
    const triggered = interpret(input).metrics.find((m) => m.id === "triggered")!;
    expect(triggered.annotation).toEqual({ code: "surge_rate", value: 5000 });
  });

  it("does not select trigger_spike when completions keep pace and pending falls", () => {
    // 3× the normal trigger rate, but the backlog is draining (net >= 0, pending falling) — so the
    // spike is NOT the cause of degradation (elevated latency is). Blaming it would contradict
    // its own "queue fills faster than it drains" read.
    const input: HealthInput = {
      ...INPUT_A,
      pending: { now: 400, normal: 1000, series: [500, 450, 400], estimated: false },
      throughput: { donePerMin: 3300, triggeredPerMin: 3300, normalTriggeredPerMin: 1100 },
      flowEvidence: {
        ...INPUT_A.flowEvidence,
        runningSeries: Array(9).fill(50),
        throttledShare: 0,
      },
    };
    expect(flowReason(input)).not.toBe("trigger_spike");
    expect(flowReason(input)).toBe("start_latency"); // falls through to the v1 symptom
  });

  it("does not select trigger_surge when new volume is draining", () => {
    // No baseline + high volume, but completions outpace triggers and the backlog falls — not a backup.
    const input: HealthInput = {
      ...INPUT_A,
      pending: { now: 400, normal: 1000, series: [500, 450, 400], estimated: false },
      throughput: { donePerMin: 6000, triggeredPerMin: 5000, normalTriggeredPerMin: 0 },
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
  // Pinned concurrency + rising backlog, but start latency is still healthy — saturation can grow
  // a backlog before p95 latency crosses its threshold, so the read must not assert "starts lag".
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
    throughput: { donePerMin: 820, triggeredPerMin: 3300, normalTriggeredPerMin: 1100 },
    flowEvidence: { ...INPUT_A.flowEvidence, runningSeries: Array(9).fill(50), throttledShare: 0 },
  });

  it("reports execution is healthy but never claims 'NOT a code problem'", () => {
    expect(spike.findings.find((f) => f.type === "flow")!.reason).toBe("trigger_spike");
    const md = renderReportMarkdown(spike);
    expect(md).toContain("runs that start are completing normally"); // flow exclusion (proven fact)
    expect(md).not.toContain("NOT a code problem"); // a code path may BE flooding the queue
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
    expect(ansi).not.toMatch(/[🟢🟡🔴]/u); // emoji are the markdown surface only
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
    // dequeue_stall only fires with no env-pin and no throttling, so "limits aren't the
    // bottleneck" is genuinely proven here (a throttled shape selects queue_limit_throttling).
    const codes = exclusionCodes(withFlow({ runningSeries: Array(9).fill(10) }));
    expect(codes).toContain("not_your_code");
    expect(codes).toContain("not_your_config");
  });

  it("trigger_spike observes healthy execution without ruling out user code", () => {
    // Backing-up spike (net < 0, pending rising) with healthy execution -> "execution_healthy" as
    // an OBSERVATION, NOT the exclusion "not_your_code": a code path fanning out task.trigger could
    // BE the cause of the spike, so it must not be ruled out.
    const healthyInput = withFlow(
      { runningSeries: Array(9).fill(50), throttledShare: 0 },
      { throughput: { donePerMin: 820, triggeredPerMin: 3300, normalTriggeredPerMin: 1100 } }
    );
    expect(observationCodes(healthyInput)).toContain("execution_healthy");
    expect(exclusionCodes(healthyInput)).not.toContain("not_your_code");

    // Execution failing -> can't even observe that execution is healthy.
    const degradedInput = withFlow(
      { runningSeries: Array(9).fill(50), throttledShare: 0 },
      {
        throughput: { donePerMin: 820, triggeredPerMin: 3300, normalTriggeredPerMin: 1100 },
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
    expect(flow.severity).toBe("crit"); // consistent across summary / section glyph / JSON
    expect(flow.recommendation).toBeUndefined();
    expect(flow.attribution).toBeUndefined();
    expect(flow.exclusions).toBeUndefined();
    expect(flow.observations).toBeUndefined();
    expect(flow.anomalyWindow).toBeUndefined(); // no stale causal evidence left in the VM
  });

  it("marks execution unknown + crit too", () => {
    expect(execution.reason).toBe("unknown");
    expect(execution.severity).toBe("crit");
  });

  it("strips stale-derived metric annotations so format=json can't leak them", () => {
    // Golden A sets concurrency.annotation ("pinned 40 of last 60 min") before the guard runs;
    // a stale feed must not surface that narrative on the raw JSON metrics.
    expect(stale.metrics.every((m) => m.annotation === undefined)).toBe(true);
  });

  it("renders both sections red as unknown, with no stale causal verdict", () => {
    // The unknown headline already says "data stale"; there's no `read:` line to render (it would
    // just repeat that), and no stale causal evidence (anomaly window) survives.
    const md = renderReportMarkdown(stale);
    expect(md).toContain("🔴 Flow unknown — data stale");
    expect(md).toContain("🔴 flow can't be assessed");
    expect(md).not.toContain("(last 40 min)"); // anomaly window gone
  });

  it("drops the CH-derived link from the VM when telemetry is stale", () => {
    // flow's "concurrency" link is gone; only liveness' control-plane link may remain.
    expect(stale.links.map((l) => l.key)).not.toContain("concurrency");
  });

  it("flags the structured facts informational-only so an agent won't act on stale numbers", () => {
    expect(stale.facts).toMatchObject({ trustworthy: false, staleReason: "telemetry_stale" });
    // fresh input is trustworthy.
    expect(interpret(INPUT_A).facts).toMatchObject({ trustworthy: true });
  });
});

describe("freshness unknown is distinct from lagging", () => {
  it("renders 'data freshness unknown' in the summary, not 'data lagging'", () => {
    const md = renderReportMarkdown(interpret({ ...INPUT_A, liveness: { telemetryAgeMs: null } }));
    expect(md).toContain("data freshness unknown");
    expect(md).not.toContain("data lagging");
  });

  it("does not change the flow severity policy (drainable crit still downgrades to warn)", () => {
    const fresh = interpret(INPUT_A).findings.find((f) => f.type === "flow")!;
    const unknown = interpret({ ...INPUT_A, liveness: { telemetryAgeMs: null } }).findings.find(
      (f) => f.type === "flow"
    )!;
    expect(unknown.severity).toBe(fresh.severity); // warn, unaffected by unknown freshness
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
