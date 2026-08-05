/**
 * The report's text surfaces: monospace markdown and ANSI.
 *
 * Structure, labels, wording and glyphs come from `report-layout.ts`, which the React card also
 * consumes, so the surfaces can't drift. This module owns typography only: column alignment, the
 * sparkline column, indentation, and (for ANSI) colour.
 *
 * Nothing here relies on colour to carry meaning: every verdict, direction and caveat is a glyph,
 * because an MCP host renders plain text.
 */

import {
  buildReportLayout,
  REPORT_GLYPH,
  REPORT_LABELS,
  type LayoutFinding,
  type LayoutMetricRow,
  type LayoutViewModel,
  type ReportLayout,
} from "./report-layout";
import { reportMessages } from "./report-messages";
import { type ReportViewModel } from "./report-view-model";

const BARS = "▁▂▃▄▅▆▇█";

/**
 * Markdown-only status colour. Chat hosts render neither ANSI nor HTML, so swapping the glyphs for
 * traffic-light circles is the one colour cue they get. The glyph and the emoji mean the same
 * thing, so meaning never depends on which one a host shows.
 */
const MARKDOWN_STATUS_EMOJI: Record<string, string> = {
  [REPORT_GLYPH.ok]: "🟢",
  [REPORT_GLYPH.warn]: "🟡",
  [REPORT_GLYPH.crit]: "🔴",
  [REPORT_GLYPH.neutral]: "⚪",
  [REPORT_GLYPH.untrusted]: "🚩",
};

const STATUS_GLYPHS = new RegExp(`[${Object.keys(MARKDOWN_STATUS_EMOJI).join("")}]`, "g");

function toMarkdownEmoji(text: string): string {
  return text.replace(STATUS_GLYPHS, (glyph) => MARKDOWN_STATUS_EMOJI[glyph] ?? glyph);
}

/** Metric rows shown for a finding's evidence block. */
const EVIDENCE_CAP = 4;

/** Column where the header's scope, period and baseline start. */
const HEADER_COL = 22;

/** Gap between aligned columns. */
const COL_GAP = 3;

/** Section labels pad to this so every finding's text starts at the same column. */
const SECTION_LABEL_WIDTH = 9; // "EXECUTION"
const SECTION_GAP = 3;

/** `read:` / `why:` labels sit in their own column so their lines hang as one paragraph. */
const NOTE_LABEL_WIDTH = Math.max(REPORT_LABELS.read.length, REPORT_LABELS.why.length);

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

/** A metric's trailing aside. An annotation speaks for itself; the rest is context, so it brackets. */
function trailingNote(row: LayoutMetricRow): string {
  if (!row.note) return "";
  return row.note.kind === "annotation" ? row.note.text : `(${row.note.text})`;
}

/** Column widths for an evidence block, so value, delta and sparkline align down the page. */
type Cols = { label: number; value: number; delta: number };

function computeColumns(rows: LayoutMetricRow[]): Cols {
  const labels = rows.flatMap((row) => [
    row.label.length,
    ...row.subRows.map((sub) => sub.label.length + SUB_ROW_INDENT),
  ]);
  const values = rows.flatMap((row) => [
    row.value.length,
    ...row.subRows.map((s) => s.value.length),
  ]);
  return {
    label: Math.max(0, ...labels),
    value: Math.max(0, ...values),
    delta: Math.max(0, ...rows.map((row) => (row.delta?.text ?? "").length)),
  };
}

/** A composite metric's parts sit under it, still on the shared value column. */
const SUB_ROW_INDENT = 2;

function renderMetricRow(row: LayoutMetricRow, cols: Cols, indent: string): string[] {
  const gap = " ".repeat(COL_GAP);
  const spark = row.series ? sparklineFromSeries(row.series) : "";
  const note = trailingNote(row);

  // The fixed-width spark column keeps every sparkline and every trailing note aligned.
  let line = `${indent}${row.label.padEnd(cols.label)}${gap}${row.value.padEnd(cols.value)}`;
  if (cols.delta > 0) line += `${gap}${(row.delta?.text ?? "").padEnd(cols.delta)}`;
  line += `${gap}${spark.padEnd(SPARK_WIDTH)}`;
  if (note) line += `${gap}${note}`;

  return [
    line.replace(/\s+$/, ""),
    ...row.subRows.map((sub) => {
      const label = `${" ".repeat(SUB_ROW_INDENT)}${sub.label}`.padEnd(cols.label);
      return `${indent}${label}${gap}${sub.value}`;
    }),
  ];
}

/** A labelled block whose lines hang under the label's column. */
function renderNoteBlock(label: string, lines: string[], indent: string): string[] {
  if (lines.length === 0) return [];
  const hang = " ".repeat(indent.length + NOTE_LABEL_WIDTH + 1);
  return lines.map((line, i) =>
    i === 0 ? `${indent}${label.padEnd(NOTE_LABEL_WIDTH)} ${line}` : `${hang}${line}`
  );
}

/** A finding's evidence: its metric rows, then `why:`. */
function renderFindingBody(finding: LayoutFinding, indent: string): string[] {
  const rows = finding.metrics.slice(0, EVIDENCE_CAP);
  const cols = computeColumns(rows);
  const metricLines = rows.flatMap((row, i) => {
    const rendered = renderMetricRow(row, cols, indent);
    // One blank line between rows so the block breathes.
    return i === 0 ? rendered : ["", ...rendered];
  });
  const why = renderNoteBlock(REPORT_LABELS.why, finding.why, indent);
  return why.length > 0 ? [...metricLines, "", ...why] : metricLines;
}

/** Glyph, then the padded section label, so every finding's text starts on one column. */
function findingLine(finding: LayoutFinding): string {
  return `${finding.glyph} ${finding.label.padEnd(SECTION_LABEL_WIDTH)}${" ".repeat(SECTION_GAP)}${finding.text}`;
}

const BODY_INDENT = "  ";
/** A non-hero finding's body hangs under its section label rather than the page margin. */
const NESTED_INDENT = "    ";

/**
 * The plain monochrome layout every text surface shares. ANSI paints this via `paintReport` and
 * markdown swaps the glyphs for emoji, so the two can't drift from each other or from the card.
 */
function renderReportPlain(vm: LayoutViewModel): string {
  const layout: ReportLayout = buildReportLayout(vm, reportMessages(vm.title));
  const lines: string[] = [];

  // header: the report as its command (plus a trust flag), then scope · period · baseline.
  const command = `/report ${layout.header.name}`;
  const left = layout.trust
    ? `${command}  ${REPORT_GLYPH.untrusted} ${layout.trust.badge}`
    : command;
  // Two spaces minimum, so a long left side still reads as two columns.
  const gutter = " ".repeat(Math.max(2, HEADER_COL - left.length));
  lines.push(`${left}${gutter}${layout.header.meta}`.replace(/\s+$/, ""), "");

  const { glyph, phrase, text } = layout.headline;
  lines.push(`${glyph} ${phrase}${text ? ` — ${text}` : ""}`, "");

  if (layout.trust) lines.push(`${REPORT_GLYPH.untrusted} ${layout.trust.note}`, "");

  if (layout.hero) {
    const body = renderFindingBody(layout.hero, BODY_INDENT);
    if (body.length > 0) lines.push(...body, "");
  }

  for (const finding of layout.findings) {
    lines.push(findingLine(finding));
    if (finding.expanded) {
      const body = renderFindingBody(finding, NESTED_INDENT);
      if (body.length > 0) lines.push("", ...body);
    }
    lines.push("");
  }

  for (const statement of layout.statements) {
    lines.push(`${statement.glyph} ${statement.text}`, "");
  }

  const reads = renderNoteBlock(REPORT_LABELS.read, layout.reads, BODY_INDENT);
  if (reads.length > 0) lines.push(...reads, "");

  // footer: the first entry leads with an arrow, the rest align under it.
  lines.push(
    ...layout.footer.map((entry, i) => (i === 0 ? `→ ${entry.label}` : `  ${entry.label}`))
  );

  return lines.join("\n").replace(/\n+$/, "\n");
}

/** Markdown surface: the plain layout with the status glyphs swapped for status emoji. */
export function renderReportMarkdown(vm: ReportViewModel): string {
  return toMarkdownEmoji(renderReportPlain(vm));
}

// The ANSI renderer colourises the same plain layout as a post-pass, so terminal output can't drift.

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

/** Colourise the plain report by role. Detection reads the raw line, wrapping the escaped line. */
function paintReport(text: string, p: Paint): string {
  const noteLabels = `(?:${REPORT_LABELS.read}|${REPORT_LABELS.why})`;
  return text
    .split("\n")
    .map((raw, i) => {
      // whole-line secondary: a read:/why: block and its hanging lines.
      if (new RegExp(`^\\s*${noteLabels}`).test(raw) || /^\s{6,}\S/.test(raw)) {
        return p.grey(p.escape(raw));
      }

      // header: grey the right column (scope · period · baseline), then paint its glyphs below.
      let l = p.escape(raw);
      if (i === 0) l = l.replace(/^(\/report .*\s{2,})(\S.*)$/, (_, a, b) => a + p.grey(b));
      l = l.replace(/[▁▂▃▄▅▆▇█]+/g, (m) => paintSpark(m, p)); // two-tone sparkline
      l = l
        .replace(new RegExp(REPORT_GLYPH.ok, "g"), p.green(REPORT_GLYPH.ok))
        .replace(new RegExp(REPORT_GLYPH.warn, "g"), p.amber(REPORT_GLYPH.warn))
        .replace(new RegExp(REPORT_GLYPH.crit, "g"), p.red(REPORT_GLYPH.crit))
        .replace(new RegExp(REPORT_GLYPH.neutral, "g"), p.grey(REPORT_GLYPH.neutral))
        .replace(new RegExp(REPORT_GLYPH.untrusted, "g"), p.amber(REPORT_GLYPH.untrusted));
      l = l.replace(/↑ ?\d+×/g, (m) => p.amber(m)).replace(/↓ ?\d+×/g, (m) => p.green(m));
      l = l.replace(/→ flat/g, (m) => p.grey(m));
      l = l.replace(/\(last \d+ min\)|\(\d+ min window\)|for the last \d+ min/g, (m) => p.amber(m));
      l = l.replace(/\(normal ~[^)]*\)|\(estimated[^)]*\)/g, (m) => p.grey(m)); // context, not a verdict
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
