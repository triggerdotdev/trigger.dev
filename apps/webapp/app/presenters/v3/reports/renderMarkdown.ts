/**
 * GENERIC renderer: ReportViewModel -> monospace markdown. Severity-driven disclosure:
 * a degraded finding expands into evidence in causal order; a healthy finding collapses
 * to one `✓` line. Owns ALL presentation (formatting, glyphs, sparklines, spacing, {token}
 * substitution) and resolves the VM's codes -> strings via the report's registered message
 * catalog, looked up by `vm.title` — so it holds NO report vocabulary itself.
 *
 * Knows NOTHING about health — walks summary -> findings -> metrics generically.
 */

import { reportMessages, type ReportMessages } from "./report-messages";
import {
  type Finding,
  type FooterEntry,
  type Metric,
  type ReportViewModel,
  type Severity,
  type Unit,
} from "./report-view-model";

const BARS = "▁▂▃▄▅▆▇█";
const MINUS = "−"; // U+2212

const SEVERITY_GLYPH: Record<Severity, string> = { ok: "✓", warn: "⚠", crit: "✕" };

/**
 * A NEUTRAL marker for a state that's genuinely unknown, not good/bad — e.g. liveness with no
 * telemetry signal. It doesn't affect the aggregate severity (that stays driven by real findings),
 * but it must not read as a confident green "✓", so it gets its own glyph.
 */
const NEUTRAL_GLYPH = "○";

/**
 * Markdown-only status colour. Chat hosts render neither ANSI nor HTML, so swapping
 * the glyphs for traffic-light circles is the one colour cue they get — one emoji per
 * marker (neutral -> white). ANSI keeps the crisp ✓/⚠/✕/○, so this applies ONLY on markdown.
 */
const MARKDOWN_STATUS_EMOJI: Record<string, string> = {
  "✓": "🟢",
  "⚠": "🟡",
  "✕": "🔴",
  "○": "⚪",
};

function toMarkdownEmoji(text: string): string {
  return text.replace(/[✓⚠✕○]/g, (g) => MARKDOWN_STATUS_EMOJI[g] ?? g);
}

/** Glyph for a finding/statement: neutral for a genuinely-unknown freshness, else severity-driven. */
function statusGlyph(severity: Severity, reason?: string): string {
  return reason === "freshness_unknown" ? NEUTRAL_GLYPH : SEVERITY_GLYPH[severity];
}

/** Evidence lines (metric rows + attribution) shown for a degraded section. */
const EVIDENCE_CAP = 4;

/** Column where the header's scope·period·baseline starts (mirrors the mockup). */
const HEADER_COL = 22;

/** Gap between aligned columns in an evidence block. */
const COL_GAP = 3;

/** Section labels pad to this so their glyph/content aligns vertically. */
const SECTION_LABEL_WIDTH = 9; // "EXECUTION"
const SECTION_GAP = 3;

/** Section label padded so every section's ✓ / cause text starts at the same column. */
function sectionLabel(type: string): string {
  return `${type.toUpperCase().padEnd(SECTION_LABEL_WIDTH)}${" ".repeat(SECTION_GAP)}`;
}

// ---------------------------------------------------------------------------
// Formatters.
// ---------------------------------------------------------------------------

/** All sparklines render at this fixed width so they align in a column. */
const SPARK_WIDTH = 8;

/** Resample to exactly `width` points (bucket-average) so every sparkline aligns. */
function resampleToWidth(points: number[], width: number): number[] {
  if (points.length === 0) return [];
  if (points.length === width) return points;
  if (points.length < width) {
    // stretch: nearest-sample up to width (keeps shape).
    return Array.from({ length: width }, (_, i) => points[Math.floor((i * points.length) / width)]);
  }
  const out: number[] = [];
  const stride = points.length / width;
  for (let i = 0; i < width; i++) {
    const slice = points.slice(
      Math.floor(i * stride),
      Math.max(Math.floor((i + 1) * stride), Math.floor(i * stride) + 1)
    );
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}

export function sparklineFromSeries(points: number[]): string {
  if (points.length === 0) return "";
  const p = resampleToWidth(points, SPARK_WIDTH);
  const min = Math.min(...p);
  const max = Math.max(...p);
  if (max === min) return BARS[0].repeat(SPARK_WIDTH);
  return p.map((v) => BARS[Math.round(((v - min) / (max - min)) * (BARS.length - 1))]).join("");
}

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

function fmtSignedRate(net: number): string {
  const sign = net < 0 ? MINUS : net > 0 ? "+" : "";
  return `${sign}${fmtCount(Math.abs(net))}/min`;
}

function fmtValue(value: number, unit: Unit): string {
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

function fill(template: string, tokens: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = tokens[k];
    return v === undefined ? `{${k}}` : String(v);
  });
}

function metricById(metrics: Metric[], id: string): Metric | undefined {
  return metrics.find((m) => m.id === id);
}

// ---------------------------------------------------------------------------
// Metric line (expanded evidence).
// ---------------------------------------------------------------------------

function deltaSegment(metric: Metric): string {
  if (metric.severity === "ok" || !metric.delta || metric.delta.dir === "flat") return "";
  const arrow = metric.delta.dir === "up" ? "↑" : "↓";
  // "up" shows the multiplier when we have it ("↑ 16×"). "down" is arrow-only: a
  // drop rounds to 0×/1×, meaningless — the arrow already says "below normal".
  if (metric.delta.dir === "down") return arrow;
  return metric.delta.mult === undefined ? arrow : `${arrow} ${metric.delta.mult}×`;
}

function annotationSegment(metric: Metric, vm: ReportViewModel): string {
  if (!metric.annotation) return "";
  const value = String(metric.annotation.value ?? "");
  return fill(reportMessages(vm.title).annotationMessage(metric.annotation.code), {
    value,
    window: vm.windowMinutes,
    limit: metric.breakdown?.limit ?? "",
  });
}

function metricValueText(metric: Metric, msg: ReportMessages): string {
  // concurrency etc. carry a limit -> "running/limit".
  if (metric.unit === "count" && metric.breakdown?.limit !== undefined) {
    return `${fmtCount(metric.value)}/${fmtCount(metric.breakdown.limit)}`;
  }
  // composite throughput -> "done vs triggered -> net".
  if (metric.unit === "perMin" && metric.breakdown?.done !== undefined) {
    const { done, triggered } = metric.breakdown;
    return `${fmtRate(done)} done  vs  ${fmtRate(triggered)} triggered  →  net ${fmtSignedRate(metric.value)}`;
  }
  const showAgg =
    metric.aggregation === "p95" && !msg.metricLabel(metric.id).toLowerCase().startsWith("p95");
  return showAgg
    ? `p95 ${fmtValue(metric.value, metric.unit)}`
    : fmtValue(metric.value, metric.unit);
}

/** Column widths for a section's evidence block, so value/delta/spark align down the page. */
type Cols = { label: number; value: number; delta: number };

function isComposite(metric: Metric): boolean {
  return metric.unit === "perMin" && metric.breakdown?.done !== undefined;
}

function computeColumns(rows: Metric[], vm: ReportViewModel, extraLabels: string[]): Cols {
  const msg = reportMessages(vm.title);
  const labelLens = [
    ...rows.map((m) => msg.metricLabel(m.id).length),
    ...extraLabels.map((l) => l.length),
  ];
  const valueLens = rows.filter((m) => !isComposite(m)).map((m) => metricValueText(m, msg).length);
  const deltaLens = rows
    .filter((m) => !isComposite(m) && !annotationSegment(m, vm))
    .map((m) => deltaSegment(m).length);
  return {
    label: Math.max(0, ...labelLens),
    value: Math.max(0, ...valueLens),
    delta: Math.max(0, ...deltaLens),
  };
}

function renderMetricRow(metric: Metric, cols: Cols, vm: ReportViewModel): string {
  const msg = reportMessages(vm.title);
  const gap = " ".repeat(COL_GAP);
  const label = msg.metricLabel(metric.id).padEnd(cols.label);
  const value = metricValueText(metric, msg);

  // composite throughput: label + value only (its own grammar).
  if (isComposite(metric)) return `  ${label}${gap}${value}`;

  const spark =
    metric.series && metric.series.points.length > 0
      ? sparklineFromSeries(metric.series.points)
      : "";
  const annotation = annotationSegment(metric, vm);
  const delta = annotation ? "" : deltaSegment(metric); // cause line carries an annotation, not a delta
  const trailing = annotation
    ? annotation
    : metric.normal !== undefined
      ? `(normal ~${fmtValue(metric.normal, metric.unit)})`
      : metric.series?.kind === "estimated"
        ? "(estimated)" // proxy trend (e.g. snapshot backlog) — flag it so it isn't read as measured
        : "";

  // Fixed columns: label · value · delta · SPARK · trailing. The fixed-width spark
  // column keeps every spark and the trailing (normal / annotation) aligned.
  let line = `  ${label}${gap}${value.padEnd(cols.value)}`;
  if (cols.delta > 0) line += `${gap}${delta.padEnd(cols.delta)}`;
  line += `${gap}${(spark || "").padEnd(SPARK_WIDTH)}`;
  if (trailing) line += `${gap}${trailing}`;
  return line.replace(/\s+$/, "");
}

// ---------------------------------------------------------------------------
// Compact facts (collapsed / semi-expanded healthy sections).
// ---------------------------------------------------------------------------

function compactFact(metric: Metric): string | undefined {
  switch (metric.id) {
    case "pending":
      return `pending ${fmtCount(metric.value)}${metric.normal !== undefined ? ` (normal ~${fmtCount(metric.normal)})` : ""}`;
    case "start_latency_p95":
      return `starts p95 ${fmtDuration(metric.value)}`;
    case "failures":
      return `failures ${fmtPct(metric.value)}${metric.normal !== undefined ? ` (normal ~${fmtPct(metric.normal)})` : ""}`;
    case "dur_p95":
      return metric.severity === "ok"
        ? "durations normal"
        : `durations p95 ${fmtDuration(metric.value)}`;
    default:
      return undefined; // throughput / evidence metrics get no collapsed fact
  }
}

/** Reassuring facts read consequence-first: depth/failures before latency/duration. */
const COMPACT_ORDER = ["pending", "failures", "start_latency_p95", "dur_p95"];

function compactFacts(finding: Finding, metrics: Metric[]): string {
  return finding.metricIds
    .map((id) => metricById(metrics, id))
    .filter((m): m is Metric => m !== undefined)
    .slice()
    .sort((a, b) => COMPACT_ORDER.indexOf(a.id) - COMPACT_ORDER.indexOf(b.id))
    .map(compactFact)
    .filter((s): s is string => s !== undefined)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// Read / exclusion / attribution / window.
// ---------------------------------------------------------------------------

function readTokens(_finding: Finding, metrics: Metric[]): Record<string, string | number> {
  const triggered = metricById(metrics, "triggered");
  return {
    mult: triggered?.delta?.mult ?? "",
  };
}

function windowSuffix(finding: Finding): string {
  const aw = finding.anomalyWindow;
  if (!aw) return "";
  return aw.touchesEnd ? ` (last ${aw.minutes} min)` : ` (${aw.minutes} min window)`;
}

function attributionLine(finding: Finding, cols: Cols): string | undefined {
  const a = finding.attribution;
  if (!a) return undefined;
  const label = `worst ${a.dim}`.padEnd(cols.label);
  return `  ${label}${" ".repeat(COL_GAP)}${a.key} — ${Math.round(a.share * 100)}% of ${a.of}`;
}

// ---------------------------------------------------------------------------
// Sections.
// ---------------------------------------------------------------------------

function renderDegradedSection(finding: Finding, vm: ReportViewModel): string[] {
  const msg = reportMessages(vm.title);
  const rows = finding.metricIds
    .map((id) => metricById(vm.metrics, id))
    .filter((m): m is Metric => m !== undefined);

  const extraLabels = finding.attribution ? [`worst ${finding.attribution.dim}`] : [];
  const cols = computeColumns(rows, vm, extraLabels);

  const evidence: string[] = rows.map((m) => renderMetricRow(m, cols, vm));
  const attr = attributionLine(finding, cols);
  if (attr) evidence.push(attr);

  // One blank line between evidence rows so the block breathes.
  const spaced = evidence.slice(0, EVIDENCE_CAP).flatMap((l, i) => (i === 0 ? [l] : ["", l]));

  const lines = [
    // Lead with the glyph so the cause text lines up with the healthy sections' "✓ …".
    `${sectionLabel(finding.type)}${SEVERITY_GLYPH[finding.severity]} ${msg.findingReason(finding.type, finding.reason)}${windowSuffix(finding)}`,
    "", // blank line between the header and its evidence (matches the section/footer spacing)
    ...spaced,
  ];

  if (finding.read) {
    lines.push(
      "",
      `  read: ${fill(msg.readMessage(finding.read), readTokens(finding, vm.metrics))}`
    );
    // Exclusions ("not your code") first, then supporting observations ("runs completing at ~X/min").
    for (const excl of finding.exclusions ?? []) {
      lines.push(
        `        ${fill(msg.exclusionMessage(excl.code), { rate: fmtCount(excl.evidence?.donePerMin ?? 0) })}`
      );
    }
    for (const obs of finding.observations ?? []) {
      lines.push(
        `        ${fill(msg.observationMessage(obs.code), { rate: fmtCount(obs.evidence?.donePerMin ?? 0) })}`
      );
    }
  }
  return lines;
}

function renderHealthyExecutionExpanded(finding: Finding, vm: ReportViewModel): string[] {
  const msg = reportMessages(vm.title);
  const lines = [
    `${sectionLabel(finding.type)}${SEVERITY_GLYPH.ok} ${msg.findingReason(finding.type, finding.reason, { expanded: true })}`,
    "", // blank line between the header and its facts (matches the section/footer spacing)
    `  ${compactFacts(finding, vm.metrics)}`,
  ];
  if (finding.read) lines.push(`  read: ${msg.readMessage(finding.read)}`);
  return lines;
}

function renderCollapsedSection(finding: Finding, vm: ReportViewModel): string[] {
  const msg = reportMessages(vm.title);
  const headline = `${sectionLabel(finding.type)}${SEVERITY_GLYPH.ok} ${msg.findingReason(finding.type, finding.reason)}`;
  const facts = compactFacts(finding, vm.metrics);
  // Healthy sections stay on one line; the facts are short.
  return facts ? [`${headline} — ${facts}`] : [headline];
}

function renderLivenessLine(finding: Finding, metrics: Metric[], msg: ReportMessages): string {
  const metric = metricById(metrics, finding.metricIds[0]);
  const ageMs = metric?.value;
  const age = ageMs !== undefined && Number.isFinite(ageMs) ? fmtDuration(ageMs) : "unknown";
  const reason = msg.findingReason(finding.type, finding.reason).replace("{age}", age);
  return `${sectionLabel(finding.type)}${statusGlyph(finding.severity, finding.reason)} ${reason}`;
}

function renderFooter(footer: FooterEntry[], msg: ReportMessages): string[] {
  return footer.map((entry, i) => {
    const text = fill(msg.actionMessage(entry.code), { value: entry.value, min: entry.value });
    return i === 0 ? `→ ${text}` : `  ${text}`;
  });
}

// ---------------------------------------------------------------------------
// Top-level render.
// ---------------------------------------------------------------------------

/**
 * The plain monochrome layout (✓/⚠/✕) shared by every surface. Colour renderers paint
 * THIS via `paintReport`; markdown swaps the glyphs for emoji. Internal so the three
 * public renderers can't drift.
 */
function renderReportPlain(vm: ReportViewModel): string {
  const msg = reportMessages(vm.title);
  const lines: string[] = [];

  // header: "/report <title>" padded to a column, then scope · period · baseline.
  const left = `/report ${vm.title}`;
  const right = [vm.scope, vm.period, vm.baselineLabel].filter(Boolean).join(" · ");
  lines.push(`${left.padEnd(HEADER_COL)}${right}`, "");

  // Each statement carries its OWN glyph — one leading glyph would read as if it
  // applied only to the first statement (e.g. "✕ Flow healthy"). Per-statement is clear.
  const verdict = vm.summary.statements
    .map(
      (s) =>
        `${statusGlyph(s.severity, s.reason)} ${msg.statementMessage(s.findingType, s.severity, s.reason)}`
    )
    .join("  ·  ");
  lines.push(verdict, "");

  const flowDegraded = vm.findings.some((f) => f.type === "flow" && f.severity !== "ok");

  for (const finding of vm.findings) {
    if (finding.type === "liveness") {
      lines.push(renderLivenessLine(finding, vm.metrics, msg), "");
    } else if (finding.reason === "unknown") {
      // stale-data guard: no ✓ or facts computed from a silent feed. The guard forces crit,
      // so the glyph reads from severity (consistent with the summary + JSON).
      lines.push(
        `${sectionLabel(finding.type)}${SEVERITY_GLYPH[finding.severity]} ${msg.findingReason(finding.type, finding.reason)}`,
        ""
      );
    } else if (finding.severity !== "ok") {
      lines.push(...renderDegradedSection(finding, vm), "");
    } else if (finding.type === "execution" && flowDegraded) {
      lines.push(...renderHealthyExecutionExpanded(finding, vm), "");
    } else {
      lines.push(...renderCollapsedSection(finding, vm), "");
    }
  }

  lines.push(...renderFooter(vm.footer, msg));

  return lines.join("\n").replace(/\n+$/, "\n");
}

/**
 * Markdown surface (agents / chat). The plain layout with severity glyphs swapped for
 * status emoji — the only decoration markdown gets.
 */
export function renderReportMarkdown(vm: ReportViewModel): string {
  return toMarkdownEmoji(renderReportPlain(vm));
}

// ---------------------------------------------------------------------------
// ANSI colour renderer (terminal, e.g. `trigger report`). Colourises the SAME
// plain layout as a post-pass via `paintReport`, so terminal output can't drift.
// ---------------------------------------------------------------------------

const SPARK_LOW = "▁▂▃▄▅";
const SPARK_HIGH = "▆▇█";

/** A surface's colour functions. `low`/`high` paint the two sparkline tones. */
type Paint = {
  escape: (s: string) => string;
  green: (s: string) => string;
  amber: (s: string) => string;
  red: (s: string) => string;
  grey: (s: string) => string;
  low: (s: string) => string;
  high: (s: string) => string;
};

function paintSpark(run: string, p: Paint): string {
  return [...run]
    .map((ch) => (SPARK_HIGH.includes(ch) ? p.high(ch) : SPARK_LOW.includes(ch) ? p.low(ch) : ch))
    .join("");
}

/** Colourise the plain report by role. Detection reads the RAW line; wrapping the escaped line. */
function paintReport(text: string, p: Paint): string {
  return text
    .split("\n")
    .map((raw, i) => {
      const line = p.escape(raw);
      // header: grey the right column (scope · period · baseline).
      if (i === 0) {
        return line.replace(/^(\/report \S+\s{2,})(.+)$/, (_, a, b) => a + p.grey(b));
      }
      // whole-line secondary: read: chain, its exclusion lines, do-nothing footer.
      if (/^\s*read:/.test(raw) || /^\s{6,}\S/.test(raw)) return p.grey(line);
      if (/^\s{2}(or do nothing|open |Check status)/.test(raw)) return p.grey(line);

      let l = line;
      l = l.replace(/[▁▂▃▄▅▆▇█]+/g, (m) => paintSpark(m, p)); // two-tone sparkline
      l = l
        .replace(/✓/g, p.green("✓"))
        .replace(/⚠/g, p.amber("⚠"))
        .replace(/✕/g, p.red("✕"))
        .replace(/○/g, p.grey("○")); // neutral (unknown) marker
      l = l.replace(/↑ ?\d+×|↑/g, (m) => p.amber(m)).replace(/↓ ?\d+×|↓/g, (m) => p.green(m));
      l = l.replace(/\(last \d+ min\)|\(\d+ min window\)/g, (m) => p.amber(m)); // anomaly window
      l = l.replace(/\(normal ~[^)]*\)|\(estimated\)/g, (m) => p.grey(m)); // baseline/estimate is context
      l = l.replace(/^(\s+worst \w+\s+)(.+?)( — )/, (_, a, k, b) => a + p.green(k) + b); // attribution key (may contain spaces)
      return l;
    })
    .join("\n");
}

const ANSI_PAINT: Paint = {
  escape: (s) => s,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  grey: (s) => `\x1b[90m${s}\x1b[0m`,
  low: (s) => `\x1b[32m${s}\x1b[0m`,
  high: (s) => `\x1b[33m${s}\x1b[0m`,
};

export function renderReportAnsi(vm: ReportViewModel): string {
  return paintReport(renderReportPlain(vm), ANSI_PAINT);
}
