/**
 * The report's layout, declared once: section order, section labels, the tone -> glyph vocabulary,
 * and every string a renderer places. `renderMarkdown` (markdown + ANSI) and the React card both
 * build from `buildReportLayout`, so no surface can drift in order, labels or wording.
 *
 * A renderer decides typography only: colour, indentation, column alignment, tooltips. Anything
 * that answers "what is shown, in what order, called what" belongs here.
 *
 * Input types are deliberately loose (`aggregation?: string`, not the enum) so both the presenter's
 * `ReportViewModel` and the agent contracts' `ReportViewModelPayload` satisfy them.
 */

import { type ReportMessages } from "./report-messages";
import { type Severity, type Unit } from "./report-view-model";

// --- vocabulary -------------------------------------------------------------

/**
 * A verdict's tone. `neutral` is a genuinely-unknown state: not good, not bad, and it must never
 * read as a confident tick.
 */
export type ReportTone = "ok" | "warn" | "crit" | "neutral";

/**
 * The one glyph vocabulary. Text surfaces carry meaning in these because an MCP host shows plain
 * text and a terminal may be monochrome; ANSI paints them as well. Every character is BMP and
 * single-width, so nothing here depends on emoji fonts or colour to be legible.
 */
export const REPORT_GLYPH = {
  ok: "✓",
  warn: "⚠",
  crit: "✕",
  /** Genuinely unknown, neither good nor bad. */
  neutral: "○",
  /** The data behind the report can't be trusted. */
  untrusted: "⚑",
  /** Above its baseline. */
  up: "↑",
  /** Below its baseline. */
  down: "↓",
  /** Compared against a baseline and unmoved. */
  flat: "→",
} as const;

/** Section and block labels. Both renderers read them from here. */
export const REPORT_LABELS = {
  /** Evidence supporting a finding. */
  why: "why:",
  /** The causal chain across findings. */
  read: "read:",
  /** The footer heading. */
  nextSteps: "Next steps",
} as const;

/** The flag beside the report's name, and the caveat under its headline. */
export type LayoutTrust = { badge: string; note: string };

/**
 * Why a report's numbers can't be trusted, in its own words. Stale, absent and unmeasured are three
 * different states: a snapshot with no telemetry feed is not stale, and a caveat may only discount
 * the input it names — the aggregates the report did measure stay measured.
 */
const TRUST_CAVEATS: Record<string, LayoutTrust> = {
  telemetry_stale: {
    badge: "stale data",
    note: "The telemetry behind this report is stale, so the numbers below are informational only.",
  },
  telemetry_absent: {
    badge: "no telemetry",
    note: "No telemetry feed reached this report, so how current it is can't be confirmed; the numbers below are still measured over the window.",
  },
  flow_unmeasured: {
    badge: "unmeasured",
    note: "The queue depth could not be measured, so the backlog can't be assessed; the other numbers below are measured.",
  },
};

const TRUST_CAVEAT_FALLBACK: LayoutTrust = {
  badge: "unverified data",
  note: "The data behind this report could not be verified, so the numbers below are informational only.",
};

/**
 * The report's sections, top to bottom. A renderer walks this order; a new section has to be added
 * here first, which is what keeps the surfaces aligned. `trust` spans two places: a flag beside the
 * report's name, and its caveat under the headline.
 */
export const REPORT_SECTION_ORDER = [
  "header",
  "trust",
  "headline",
  "hero",
  "findings",
  "statements",
  "read",
  "footer",
] as const;

/**
 * Reasons that mean "we can't say" rather than a verdict, so their finding renders headline-only.
 * A measured finding never carries one: an unmeasured input costs its own metric, not the verdict.
 */
const UNASSESSABLE_REASONS = new Set(["unknown", "flow_unmeasured"]);

/**
 * Reasons whose state is genuinely unknown but not bad. A stale feed is different: the trust guard
 * forces crit.
 */
const NEUTRAL_REASONS = new Set(["freshness_unknown", "flow_unmeasured"]);

/**
 * `facts.trustworthy === false` means the numbers behind the verdict are informational only. Absent
 * = trustworthy (the common case, and what pre-`facts` snapshots imply).
 */
export function reportIsTrustworthy(vm: { facts?: Record<string, unknown> }): boolean {
  return vm.facts?.trustworthy !== false;
}

/** The caveat for an untrustworthy report, chosen by `facts.untrustworthyReason`. */
export function reportTrust(vm: { facts?: Record<string, unknown> }): LayoutTrust | undefined {
  if (reportIsTrustworthy(vm)) return undefined;
  const reason = vm.facts?.untrustworthyReason;
  return (typeof reason === "string" ? TRUST_CAVEATS[reason] : undefined) ?? TRUST_CAVEAT_FALLBACK;
}

function reportTone(severity: Severity, reason?: string): ReportTone {
  return reason !== undefined && NEUTRAL_REASONS.has(reason) ? "neutral" : severity;
}

function reportGlyph(severity: Severity, reason?: string): string {
  return REPORT_GLYPH[reportTone(severity, reason)];
}

// --- footer vocabulary ------------------------------------------------------

/**
 * How a footer entry renders, keyed off the code rather than its URL so the same code looks the
 * same everywhere. `action` is a primary control, `docs` the docs entry, `reference` a place to
 * look, and `note` an option stated rather than offered.
 */
export type ReportFooterStyle = "action" | "docs" | "reference" | "note";

const FOOTER_NOTE_CODES = new Set(["nothing_to_do", "do_nothing_drains", "region_failover"]);

const FOOTER_REFERENCE_CODES = new Set(["check_control_plane", "check_platform_status"]);

/** A doc entry names itself one: `concurrency_docs`, `retries_docs`. */
const FOOTER_DOCS_SUFFIX = "_docs";

export function reportFooterStyle(code: string): ReportFooterStyle {
  if (FOOTER_NOTE_CODES.has(code)) return "note";
  if (code.endsWith(FOOTER_DOCS_SUFFIX)) return "docs";
  if (FOOTER_REFERENCE_CODES.has(code)) return "reference";
  return "action";
}

// --- formatting -------------------------------------------------------------

const MINUS = "−"; // U+2212

function fmtCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  const m = s / 60;
  return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1)}m`;
}

function fmtPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function fmtRate(n: number): string {
  return `${fmtCount(n)}/min`;
}

/** A net rate carries its sign; a plain rate does not, so it isn't read as a change. */
function fmtSignedRate(net: number): string {
  const sign = net < 0 ? MINUS : net > 0 ? "+" : "";
  return `${sign}${fmtCount(Math.abs(net))}/min`;
}

export function fmtValue(value: number, unit: Unit): string {
  switch (unit) {
    case "ms":
      return fmtDuration(value);
    case "count":
      return fmtCount(value);
    case "ratio":
      return fmtPct(value);
    case "perMin":
      return fmtRate(value);
  }
}

/** Fill the `{token}` placeholders a message catalog leaves for the renderer. */
function fillTokens(template: string, tokens: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = tokens[key];
    if (value === undefined) return whole;
    // Grouped but never rounded: a drain ETA of 26.7 min must stay 26.7.
    return typeof value === "number" ? value.toLocaleString("en-US") : value;
  });
}

// --- input shapes -----------------------------------------------------------

type DeltaInput = { dir: "up" | "down" | "flat"; mult?: number };

export type LayoutMetricInput = {
  id: string;
  value: number;
  unit: Unit;
  aggregation?: string;
  normal?: number;
  delta?: DeltaInput;
  series?: { points: number[]; kind: string };
  breakdown?: Record<string, number>;
  annotation?: { code: string; value?: number };
  availability?: string;
  severity: Severity;
};

type LayoutFindingInput = {
  type: string;
  severity: Severity;
  reason: string;
  read?: string;
  metricIds: string[];
  anomalyWindow?: { minutes: number; touchesEnd: boolean };
  attribution?: { dim: string; key: string; share: number; of: string };
  exclusions?: { code: string; evidence?: Record<string, number> }[];
  observations?: { code: string; evidence?: Record<string, number> }[];
};

export type LayoutViewModel = {
  title: string;
  scope: string;
  period: string;
  baselineLabel?: string;
  windowMinutes: number;
  summary: {
    severity: Severity;
    statements: { findingType: string; severity: Severity; reason?: string }[];
  };
  findings: LayoutFindingInput[];
  metrics: LayoutMetricInput[];
  facts?: Record<string, unknown>;
  footer: { code: string; link?: string; value?: number }[];
};

// --- output shapes ----------------------------------------------------------

type LayoutDelta = { text: string; dir: "up" | "down" | "flat" };

/** A metric's aside. `kind` lets a renderer choose its own frame around shared wording. */
type LayoutNote = { kind: "annotation" | "baseline" | "estimated"; text: string };

export type LayoutMetricRow = {
  id: string;
  label: string;
  value: string;
  /** Kept alongside the formatted value so a chart can format its own points. */
  unit: Unit;
  severity: Severity;
  delta?: LayoutDelta;
  note?: LayoutNote;
  /** The row that explains the finding: its annotation is spelled out rather than tucked away. */
  hero: boolean;
  series?: number[];
  /** Trailing breach window of the driving metric, when it reaches now. */
  anomalyMinutes?: number;
  /** A composite metric's parts, shown under it. */
  subRows: { label: string; value: string }[];
};

export type LayoutFinding = {
  type: string;
  /** Column label for the section, e.g. "EXECUTION". */
  label: string;
  severity: Severity;
  tone: ReportTone;
  glyph: string;
  /** The resolved reason, plus its anomaly window. */
  text: string;
  /** Whether the evidence block is shown at all. */
  expanded: boolean;
  metrics: LayoutMetricRow[];
  /** Evidence lines under `why:`. */
  why: string[];
  /** The attributed key, so a renderer can pick it out of the first `why:` line. */
  attributionKey?: string;
};

type LayoutStatement = { tone: ReportTone; glyph: string; severity: Severity; text: string };

type LayoutFooterEntry = {
  code: string;
  style: ReportFooterStyle;
  label: string;
  /** Key into `vm.links`. */
  link?: string;
};

export type ReportLayout = {
  header: { name: string; meta: string };
  /** Present only when the data can't be trusted. */
  trust?: LayoutTrust;
  headline: { tone: ReportTone; glyph: string; severity: Severity; phrase: string; text?: string };
  /** The finding the headline speaks for, always expanded. */
  hero?: LayoutFinding;
  /** The remaining findings, in view-model order. */
  findings: LayoutFinding[];
  /** Statements with no finding behind them, which still have to be said. */
  statements: LayoutStatement[];
  reads: string[];
  footer: LayoutFooterEntry[];
};

// --- build ------------------------------------------------------------------

/** The layout of `vm`, with every code already resolved through `messages`. */
export function buildReportLayout(vm: LayoutViewModel, messages: ReportMessages): ReportLayout {
  const tokens = reportTokens(vm);

  const heroIndex = heroIndexOf(vm);
  const heroInput = vm.findings[heroIndex];
  const heroStatement = vm.summary.statements.find((s) => s.findingType === heroInput?.type);

  const hero = heroInput ? findingLayout(vm, messages, heroInput, tokens, true) : undefined;
  const findings = vm.findings
    .filter((_, i) => i !== heroIndex)
    .map((finding) => findingLayout(vm, messages, finding, tokens, false));

  // The headline speaks for the hero finding. When its statement carries its own reason (stale
  // telemetry, no freshness signal) that statement is the whole sentence and the finding's reason
  // would only repeat it.
  const phrase = heroInput
    ? messages.statementMessage(heroInput.type, heroInput.severity, heroStatement?.reason)
    : messages.statementMessage(vm.title, vm.summary.severity);
  const text =
    heroInput && !heroStatement?.reason
      ? fillTokens(
          messages.findingReason(heroInput.type, heroInput.reason, {
            expanded: heroInput.severity === "ok",
          }),
          tokens
        ) + headlineWindow(heroInput)
      : undefined;

  const statements = vm.summary.statements
    .filter((statement) => !vm.findings.some((f) => f.type === statement.findingType))
    .map((statement) => ({
      severity: statement.severity,
      tone: reportTone(statement.severity, statement.reason),
      glyph: reportGlyph(statement.severity, statement.reason),
      text: messages.statementMessage(statement.findingType, statement.severity, statement.reason),
    }));

  // Hero first, then the rest. An unassessable finding contributes nothing: its read would only
  // repeat the trust note.
  const reads = (
    hero ? [heroInput!, ...vm.findings.filter((_, i) => i !== heroIndex)] : vm.findings
  )
    .filter((finding) => finding.read !== undefined && !UNASSESSABLE_REASONS.has(finding.reason))
    .map((finding) => fillTokens(messages.readMessage(finding.read!), tokens));

  const trust = reportTrust(vm);

  return {
    header: {
      name: vm.title,
      meta: [vm.scope, vm.period, vm.baselineLabel].filter(Boolean).join(" · "),
    },
    ...(trust === undefined ? {} : { trust }),
    headline: {
      severity: vm.summary.severity,
      tone: reportTone(vm.summary.severity, heroStatement?.reason),
      glyph: reportGlyph(vm.summary.severity, heroStatement?.reason),
      phrase,
      ...(text === undefined ? {} : { text }),
    },
    ...(hero === undefined ? {} : { hero }),
    findings,
    statements,
    reads,
    footer: footerLayout(vm, messages, tokens),
  };
}

/** The finding the headline speaks for: the first one at the report's severity. */
function heroIndexOf(vm: LayoutViewModel): number {
  const index = vm.findings.findIndex((finding) => finding.severity === vm.summary.severity);
  return index === -1 ? 0 : index;
}

/** Tokens the catalog's strings leave for the renderer, resolved from the view model's metrics. */
function reportTokens(vm: LayoutViewModel): Record<string, string | number> {
  const metric = (id: string) => vm.metrics.find((m) => m.id === id);
  const triggered = metric("triggered");
  const throughput = metric("throughput");
  const liveness = metric("liveness");
  return {
    mult: triggered?.delta?.mult ?? "",
    rate: Math.round(throughput?.breakdown?.done ?? 0),
    age: liveness === undefined || isUnmeasured(liveness) ? "unknown" : fmtDuration(liveness.value),
  };
}

function isUnmeasured(metric: LayoutMetricInput): boolean {
  return metric.availability === "unknown" || !Number.isFinite(metric.value);
}

/** The anomaly window as the headline says it. */
function headlineWindow(finding: LayoutFindingInput): string {
  const window = finding.anomalyWindow;
  if (!window) return "";
  return window.touchesEnd
    ? ` for the last ${window.minutes} min`
    : ` (${window.minutes} min window)`;
}

/** The same window on a finding line, where it is an aside rather than the sentence's tail. */
function findingWindow(finding: LayoutFindingInput): string {
  const window = finding.anomalyWindow;
  if (!window) return "";
  return window.touchesEnd ? ` (last ${window.minutes} min)` : ` (${window.minutes} min window)`;
}

function findingLayout(
  vm: LayoutViewModel,
  messages: ReportMessages,
  finding: LayoutFindingInput,
  tokens: Record<string, string | number>,
  hero: boolean
): LayoutFinding {
  // A finding whose reason says "we can't say" shows no evidence: the numbers behind it are
  // placeholders. Otherwise the hero is always expanded, and the rest only when degraded.
  // A self-evident finding's one metric only repeats its own line ("stale — no telemetry in 21m"
  // over "liveness 21m"); as the hero that line is the headline, so the row is its only evidence.
  const selfEvident = finding.metricIds.length === 1 && finding.metricIds[0] === finding.type;
  const expanded =
    !UNASSESSABLE_REASONS.has(finding.reason) &&
    (hero || (finding.severity !== "ok" && !selfEvident));

  const metrics = expanded
    ? finding.metricIds
        .map((id) => vm.metrics.find((m) => m.id === id))
        .filter((m): m is LayoutMetricInput => m !== undefined)
        .map((metric, i) =>
          metricRow(vm, messages, metric, i === 0, i === 0 ? anomalyMinutes(finding) : undefined)
        )
    : [];

  return {
    type: finding.type,
    label: finding.type.toUpperCase(),
    severity: finding.severity,
    tone: reportTone(finding.severity, finding.reason),
    glyph: reportGlyph(finding.severity, finding.reason),
    text:
      fillTokens(
        messages.findingReason(finding.type, finding.reason, {
          expanded: finding.severity === "ok",
        }),
        tokens
      ) + findingWindow(finding),
    expanded,
    metrics,
    why: expanded ? whyLines(messages, finding, tokens) : [],
    ...(expanded && finding.attribution ? { attributionKey: finding.attribution.key } : {}),
  };
}

function anomalyMinutes(finding: LayoutFindingInput): number | undefined {
  return finding.anomalyWindow?.touchesEnd ? finding.anomalyWindow.minutes : undefined;
}

/** Attribution first, then ruled-out causes, then supporting observations. */
function whyLines(
  messages: ReportMessages,
  finding: LayoutFindingInput,
  tokens: Record<string, string | number>
): string[] {
  const lines: string[] = [];
  const attribution = finding.attribution;
  if (attribution) {
    lines.push(
      `${Math.round(attribution.share * 100)}% of ${attribution.of} is ${attribution.key}`
    );
  }
  for (const exclusion of finding.exclusions ?? []) {
    lines.push(
      fillTokens(
        messages.exclusionMessage(exclusion.code),
        evidenceTokens(tokens, exclusion.evidence)
      )
    );
  }
  for (const observation of finding.observations ?? []) {
    lines.push(
      fillTokens(
        messages.observationMessage(observation.code),
        evidenceTokens(tokens, observation.evidence)
      )
    );
  }
  return lines;
}

/**
 * A code's own evidence beats the report-wide tokens. `finishedPerMin` is the measured rate behind
 * `{rate}`, so it fills that token rather than needing one of its own.
 */
function evidenceTokens(
  tokens: Record<string, string | number>,
  evidence: Record<string, number> | undefined
): Record<string, string | number> {
  if (!evidence) return tokens;
  return {
    ...tokens,
    ...evidence,
    ...(evidence.finishedPerMin === undefined ? {} : { rate: evidence.finishedPerMin }),
  };
}

function isComposite(metric: LayoutMetricInput): boolean {
  return metric.unit === "perMin" && metric.breakdown?.done !== undefined;
}

function metricValue(metric: LayoutMetricInput, messages: ReportMessages): string {
  // A placeholder is never printed as a number.
  if (isUnmeasured(metric)) return "unknown";
  // concurrency etc. carry a limit -> "running/limit".
  if (metric.unit === "count" && metric.breakdown?.limit !== undefined) {
    return `${fmtCount(metric.value)}/${fmtCount(metric.breakdown.limit)}`;
  }
  // A composite throughput's value is the net, which is signed; its parts are sub-rows.
  if (isComposite(metric)) return fmtSignedRate(metric.value);
  const showAggregation =
    metric.aggregation === "p95" &&
    !messages.metricLabel(metric.id).toLowerCase().startsWith("p95");
  return showAggregation
    ? `p95 ${fmtValue(metric.value, metric.unit)}`
    : fmtValue(metric.value, metric.unit);
}

/**
 * How far a metric fell below its baseline: `undefined` when the fall doesn't round past 1×, and
 * `null` when it collapsed to nothing and no multiplier can say it.
 */
function fallMultiplier(metric: LayoutMetricInput): number | null | undefined {
  if (metric.normal === undefined || metric.normal <= 0) return undefined;
  if (metric.value <= 0) return null;
  const fall = Math.round(metric.normal / metric.value);
  return fall > 1 ? fall : undefined;
}

/**
 * A metric's movement against its baseline. A multiplier only reads as movement once it rounds past
 * 1×; below that a metric with a baseline is flat, and one without has nothing to compare against.
 */
function metricDelta(metric: LayoutMetricInput): LayoutDelta | undefined {
  const delta = metric.delta;
  // A fall's own multiplier rounds to 0 or 1, so measure how far it fell instead.
  if (delta?.dir === "down") {
    const fall = fallMultiplier(metric);
    // An arrow with no multiplier behind it says nothing the sparkline hasn't.
    if (fall === null) return undefined;
    if (fall !== undefined) return { text: `${REPORT_GLYPH.down} ${fall}×`, dir: "down" };
  }
  if (delta && delta.mult !== undefined && delta.mult > 1 && delta.dir !== "flat") {
    return {
      text: `${delta.dir === "up" ? REPORT_GLYPH.up : REPORT_GLYPH.down} ${delta.mult}×`,
      dir: delta.dir,
    };
  }
  return metric.normal === undefined
    ? undefined
    : { text: `${REPORT_GLYPH.flat} flat`, dir: "flat" };
}

function metricNote(
  vm: LayoutViewModel,
  messages: ReportMessages,
  metric: LayoutMetricInput
): LayoutNote | undefined {
  if (metric.annotation) {
    return {
      kind: "annotation",
      text: fillTokens(messages.annotationMessage(metric.annotation.code), {
        value: metric.annotation.value,
        window: vm.windowMinutes,
        limit: metric.breakdown?.limit,
      }),
    };
  }
  if (metric.normal !== undefined) {
    return { kind: "baseline", text: `normal ~${fmtValue(metric.normal, metric.unit)}` };
  }
  // A proxy trend (e.g. a snapshot backlog) is a shape, not a measurement, so say so.
  if (metric.series?.kind === "estimated") {
    return { kind: "estimated", text: "estimated from a proxy signal" };
  }
  return undefined;
}

function metricRow(
  vm: LayoutViewModel,
  messages: ReportMessages,
  metric: LayoutMetricInput,
  hero: boolean,
  anomaly: number | undefined
): LayoutMetricRow {
  const delta = metricDelta(metric);
  const note = metricNote(vm, messages, metric);
  const points = isUnmeasured(metric) ? undefined : metric.series?.points;

  return {
    id: metric.id,
    label: messages.metricLabel(metric.id),
    value: metricValue(metric, messages),
    unit: metric.unit,
    severity: metric.severity,
    hero,
    ...(delta === undefined ? {} : { delta }),
    ...(note === undefined ? {} : { note }),
    ...(points && points.length > 0 ? { series: points } : {}),
    ...(anomaly === undefined ? {} : { anomalyMinutes: anomaly }),
    subRows: isComposite(metric)
      ? [
          { label: "done", value: fmtRate(metric.breakdown!.done!) },
          { label: "triggered", value: fmtRate(metric.breakdown!.triggered ?? 0) },
        ]
      : [],
  };
}

/** Offered entries first, stated options last — a note is the fallback, not a next step. */
function footerLayout(
  vm: LayoutViewModel,
  messages: ReportMessages,
  tokens: Record<string, string | number>
): LayoutFooterEntry[] {
  const entries = vm.footer.map((entry) => ({
    code: entry.code,
    style: reportFooterStyle(entry.code),
    label: fillTokens(messages.actionMessage(entry.code), {
      ...tokens,
      value: entry.value,
      min: entry.value,
    }),
    ...(entry.link === undefined ? {} : { link: entry.link }),
  }));
  return [
    ...entries.filter((entry) => entry.style !== "note"),
    ...entries.filter((entry) => entry.style === "note"),
  ];
}
