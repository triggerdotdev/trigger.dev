import type { ReportViewModel } from "~/presenters/v3/reports/report-view-model";
import { DEMO_WORLD } from "../ids";

const calm = (base: number, jitter: number) =>
  Array.from({ length: 60 }, (_, i) => base + Math.round(Math.sin(i / 4) * jitter));

const ramp = (from: number, to: number) =>
  Array.from({ length: 60 }, (_, i) => Math.round(from + ((to - from) * i) / 59));

export const demoHealthyReport: ReportViewModel = {
  title: "health",
  scope: "prod",
  period: "last 1h",
  baselineLabel: "vs your 7d normal",
  generatedAt: "2026-07-27T10:15:00.000Z",
  windowMinutes: 60,
  summary: {
    severity: "ok",
    statements: [
      { findingType: "flow", severity: "ok" },
      { findingType: "execution", severity: "ok" },
      { findingType: "liveness", severity: "ok" },
    ],
  },
  findings: [
    {
      type: "flow",
      severity: "ok",
      reason: "healthy",
      read: "starting_normally",
      metricIds: ["start_latency_p95", "pending", "throughput"],
    },
    {
      type: "execution",
      severity: "ok",
      reason: "healthy",
      read: "runs_are_fine",
      metricIds: ["failures", "dur_p95"],
    },
    {
      type: "liveness",
      severity: "ok",
      reason: "fresh",
      metricIds: ["liveness"],
    },
  ],
  metrics: [
    {
      id: "start_latency_p95",
      value: 6_800,
      unit: "ms",
      aggregation: "p95",
      normal: 7_000,
      delta: { dir: "down", mult: 1 },
      series: { points: calm(6_800, 400), kind: "measured" },
      severity: "ok",
    },
    {
      id: "pending",
      value: 34,
      unit: "count",
      normal: 40,
      delta: { dir: "down", mult: 1 },
      series: { points: calm(36, 8), kind: "measured" },
      severity: "ok",
    },
    {
      id: "throughput",
      value: 12,
      unit: "perMin",
      aggregation: "rate",
      breakdown: { done: 842, triggered: 830 },
      severity: "ok",
    },
    {
      id: "failures",
      value: 0.004,
      unit: "ratio",
      aggregation: "ratio",
      normal: 0.005,
      delta: { dir: "down", mult: 1 },
      series: { points: calm(4, 2).map((n) => n / 1000), kind: "measured" },
      severity: "ok",
    },
    {
      id: "dur_p95",
      value: 4_100,
      unit: "ms",
      aggregation: "p95",
      normal: 4_000,
      delta: { dir: "flat", mult: 1 },
      severity: "ok",
    },
    { id: "liveness", value: 21_000, unit: "ms", availability: "measured", severity: "ok" },
  ],
  facts: { trustworthy: true, flowSource: "queue", pendingEstimated: false },
  links: [],
  footer: [{ code: "nothing_to_do" }],
};

export const demoDegradedReport: ReportViewModel = {
  title: "health",
  scope: "prod",
  period: "last 1h",
  baselineLabel: "vs your 7d normal",
  generatedAt: "2026-07-27T10:15:00.000Z",
  windowMinutes: 60,
  summary: {
    severity: "crit",
    statements: [
      { findingType: "flow", severity: "crit" },
      { findingType: "execution", severity: "ok" },
      { findingType: "liveness", severity: "ok" },
    ],
  },
  findings: [
    {
      type: "flow",
      severity: "crit",
      reason: "env_limit_saturation",
      read: "saturation_chain",
      metricIds: ["concurrency", "pending", "start_latency_p95", "throughput"],
      recommendation: { code: "raise_env_limit", link: "concurrency_docs" },
      anomalyWindow: { minutes: 38, touchesEnd: true },
      attribution: { dim: "queue", key: DEMO_WORLD.queue, share: 0.71, of: "pending" },
      exclusions: [{ code: "not_your_code", evidence: { failures: 0.006 } }],
      observations: [{ code: "not_workers_platform", evidence: { rate: 820 } }],
    },
    {
      type: "execution",
      severity: "ok",
      reason: "healthy",
      read: "not_a_code_problem",
      metricIds: ["failures", "dur_p95"],
    },
    { type: "liveness", severity: "ok", reason: "fresh", metricIds: ["liveness"] },
  ],
  metrics: [
    {
      id: "start_latency_p95",
      value: 43_000,
      unit: "ms",
      aggregation: "p95",
      normal: 7_000,
      delta: { dir: "up", mult: 6 },
      series: { points: ramp(7_000, 43_000), kind: "measured" },
      severity: "crit",
    },
    {
      id: "pending",
      value: 4_812,
      unit: "count",
      normal: 40,
      delta: { dir: "up", mult: 120 },
      series: { points: ramp(60, 4_812), kind: "measured" },
      severity: "crit",
    },
    {
      id: "throughput",
      value: -180,
      unit: "perMin",
      aggregation: "rate",
      breakdown: { done: 820, triggered: 1_000 },
      severity: "warn",
    },
    {
      id: "failures",
      value: 0.006,
      unit: "ratio",
      aggregation: "ratio",
      normal: 0.005,
      delta: { dir: "up", mult: 1 },
      series: { points: calm(6, 2).map((n) => n / 1000), kind: "measured" },
      severity: "ok",
    },
    {
      id: "dur_p95",
      value: 4_200,
      unit: "ms",
      aggregation: "p95",
      normal: 4_000,
      delta: { dir: "flat", mult: 1 },
      severity: "ok",
    },
    {
      id: "concurrency",
      value: 50,
      unit: "count",
      breakdown: { limit: 50 },
      series: { points: ramp(28, 50), kind: "measured" },
      annotation: { code: "pinned_minutes", value: 38 },
      severity: "ok",
    },
    {
      id: "triggered",
      value: 1_000,
      unit: "perMin",
      normal: 840,
      delta: { dir: "up", mult: 1 },
      severity: "ok",
    },
    { id: "liveness", value: 18_000, unit: "ms", availability: "measured", severity: "ok" },
  ],
  facts: {
    trustworthy: true,
    flowSource: "queue",
    pendingEstimated: false,
    throughput: { donePerMin: 820, triggeredPerMin: 1_000 },
  },
  links: [
    {
      key: "concurrency_docs",
      label: "Concurrency & limits",
      url: "https://trigger.dev/docs/queue-concurrency",
    },
    { key: "contact", label: "Contact us", url: "https://trigger.dev/contact" },
  ],
  footer: [
    { code: "contact_us_raise_limit", link: "contact" },
    { code: "concurrency_docs", link: "concurrency_docs" },
    { code: "do_nothing_drains", value: 26.7 },
  ],
};

export const demoReports = {
  healthy: demoHealthyReport,
  degraded: demoDegradedReport,
} as const;
