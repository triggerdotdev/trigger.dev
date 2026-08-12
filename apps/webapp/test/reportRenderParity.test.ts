/**
 * The report is served as markdown, as ANSI and as a React card. All three build from the shared
 * layout spec (`report-layout.ts`), and these tests are what stops them drifting apart:
 *
 * - the parity test derives the report's landmarks (labels, sections, values) from the spec and
 *   asserts the card and the markdown place them in the same order, so a section added to one
 *   surface fails on the other;
 * - the snapshots pin the text surfaces over a healthy, a degraded, an untrustworthy and an
 *   empty report;
 * - the glyph test asserts nothing in markdown signals with colour alone.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  demoDegradedReport,
  demoHealthyReport,
} from "~/components/dashboard-agent/demo/fixtures/reports";
import { ReportView } from "~/components/dashboard-agent/ReportView";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import {
  buildReportLayout,
  REPORT_GLYPH,
  REPORT_LABELS,
  REPORT_SECTION_ORDER,
  reportTrust,
} from "~/presenters/v3/reports/report-layout";
import { healthMessages } from "~/presenters/v3/reports/health/health-messages";
import { renderReportAnsi, renderReportMarkdown } from "~/presenters/v3/reports/renderMarkdown";
import { type ReportViewModel } from "~/presenters/v3/reports/report-view-model";

// --- fixtures ---------------------------------------------------------------

/** Stale telemetry: the numbers survive but the verdict can't be trusted. */
const untrustworthyReport: ReportViewModel = {
  ...demoDegradedReport,
  summary: {
    severity: "crit",
    statements: [
      { findingType: "flow", severity: "crit", reason: "unknown" },
      { findingType: "execution", severity: "crit", reason: "unknown" },
      { findingType: "liveness", severity: "crit" },
    ],
  },
  findings: demoDegradedReport.findings.map((finding) =>
    finding.type === "liveness"
      ? { ...finding, severity: "crit", reason: "stale" }
      : {
          ...finding,
          severity: "crit",
          reason: "unknown",
          attribution: undefined,
          exclusions: undefined,
          observations: undefined,
          anomalyWindow: undefined,
        }
  ),
  metrics: demoDegradedReport.metrics.map((metric) =>
    metric.id === "liveness"
      ? { ...metric, value: 21 * 60_000, severity: "crit" }
      : { ...metric, annotation: undefined }
  ),
  facts: { trustworthy: false, untrustworthyReason: "telemetry_stale" },
  links: [{ key: "status", label: "status.trigger.dev", url: "https://status.trigger.dev" }],
  footer: [{ code: "check_control_plane", link: "status" }],
};

/** Nothing was found: a report still has to say something. */
const emptyReport: ReportViewModel = {
  title: "health",
  scope: "prod",
  period: "last 1h",
  generatedAt: "2026-07-27T10:15:00.000Z",
  windowMinutes: 60,
  summary: { severity: "ok", statements: [{ findingType: "liveness", severity: "ok" }] },
  findings: [],
  metrics: [],
  facts: { trustworthy: true },
  links: [],
  footer: [{ code: "nothing_to_do" }],
};

// --- helpers ----------------------------------------------------------------

/**
 * The card as one string of its text, tags removed without inserting separators: prose is split
 * across spans for highlighting, so gluing is what puts a sentence back together.
 */
function cardText(vm: ReportViewModel): string {
  const html = renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(ShortcutsProvider, null, createElement(ReportView, { vm }))
    )
  );
  // Repeat the tag strip until it settles: removing a tag can splice a new one out of the rest.
  let stripped = html;
  for (;;) {
    const next = stripped.replace(/<[^>]*>/g, "");
    if (next === stripped) break;
    stripped = next;
  }
  return stripped
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * Every string the layout says the report shows, in the order it says to show them. Metric notes
 * are left out: the card tucks them into a tooltip, which is typography, not layout.
 */
function landmarks(vm: ReportViewModel): string[] {
  const layout = buildReportLayout(vm, healthMessages);
  // The trust flag sits between the report's name and its meta on both surfaces.
  const out: string[] = [layout.header.name];
  if (layout.trust) out.push(layout.trust.badge);
  out.push(layout.header.meta, layout.headline.phrase);
  if (layout.headline.text) out.push(layout.headline.text);
  if (layout.trust) out.push(layout.trust.note);

  const findingLandmarks = (finding: (typeof layout.findings)[number], withLabel: boolean) => {
    if (withLabel) out.push(finding.label, finding.text);
    for (const row of finding.metrics) {
      out.push(row.label, row.value, ...row.subRows.flatMap((sub) => [sub.label, sub.value]));
    }
    if (finding.why.length > 0) out.push(REPORT_LABELS.why, ...finding.why);
  };

  if (layout.hero) findingLandmarks(layout.hero, false);
  for (const finding of layout.findings) findingLandmarks(finding, true);
  for (const statement of layout.statements) out.push(statement.text);
  if (layout.reads.length > 0) out.push(REPORT_LABELS.read, ...layout.reads);
  out.push(...layout.footer.map((entry) => entry.label));
  return out;
}

/**
 * The first landmark `text` doesn't have after the one before it — either missing from this surface
 * or placed out of layout order.
 */
function firstOutOfOrder(text: string, marks: string[]): string | undefined {
  let cursor = 0;
  for (const mark of marks) {
    const at = text.indexOf(mark, cursor);
    if (at === -1) return mark;
    cursor = at;
  }
  return undefined;
}

const FIXTURES: [string, ReportViewModel][] = [
  ["healthy", demoHealthyReport],
  ["degraded", demoDegradedReport],
  ["untrustworthy", untrustworthyReport],
  ["empty", emptyReport],
];

// --- parity -----------------------------------------------------------------

describe("card and markdown render one report", () => {
  for (const [name, vm] of FIXTURES) {
    it(`places every layout landmark, in layout order (${name})`, () => {
      const marks = landmarks(vm);
      for (const [surface, text] of [
        ["card", cardText(vm)],
        ["markdown", renderReportMarkdown(vm)],
      ] as const) {
        expect(firstOutOfOrder(text, marks), `${surface} misplaces or omits`).toBeUndefined();
      }
    });
  }

  it("declares the section order once, and neither renderer names a label of its own", () => {
    const renderers = {
      markdown: readFileSync(
        new URL("../app/presenters/v3/reports/renderMarkdown.ts", import.meta.url),
        "utf8"
      ),
      card: readFileSync(
        new URL("../app/components/dashboard-agent/ReportView.tsx", import.meta.url),
        "utf8"
      ),
    };

    for (const [surface, source] of Object.entries(renderers)) {
      // Labels come from the spec, never from a literal in a renderer.
      for (const label of Object.values(REPORT_LABELS)) {
        expect(source, `${surface} hardcodes "${label}"`).not.toContain(`"${label}"`);
      }
      // And every declared section is rendered, so adding one to the spec fails both surfaces
      // until both place it.
      const missing = REPORT_SECTION_ORDER.filter(
        (id) => !source.includes(`layout.${id === "read" ? "reads" : id}`)
      );
      expect(missing, `${surface} renders no`).toEqual([]);
    }
  });
});

// --- glyphs -----------------------------------------------------------------

describe("markdown carries meaning without colour", () => {
  it("marks every verdict, direction and caveat with a glyph", () => {
    const degraded = renderReportMarkdown(demoDegradedReport);
    // The status glyphs render as their emoji counterparts; direction and the trust flag stay glyphs.
    expect(degraded).toContain("🔴");
    expect(degraded).toContain("🟢");
    expect(degraded).toContain(REPORT_GLYPH.up);

    const trust = reportTrust(untrustworthyReport);
    // The caveat names the reason: a report the pipeline could name must not fall back to "unverified".
    expect(trust).toEqual({ badge: "stale data", note: expect.stringContaining("is stale") });
    const stale = renderReportMarkdown(untrustworthyReport);
    expect(stale).toContain("🚩");
    expect(stale).toContain(trust!.badge);
    expect(stale).toContain(trust!.note);
  });

  it("shows a genuinely-unknown state as neutral, not as a tick", () => {
    const unknownFreshness: ReportViewModel = {
      ...demoHealthyReport,
      summary: {
        severity: "ok",
        statements: [
          { findingType: "flow", severity: "ok" },
          { findingType: "liveness", severity: "ok", reason: "freshness_unknown" },
        ],
      },
      findings: demoHealthyReport.findings.map((finding) =>
        finding.type === "liveness" ? { ...finding, reason: "freshness_unknown" } : finding
      ),
    };
    const md = renderReportMarkdown(unknownFreshness);
    expect(md).toContain("⚪ LIVENESS");
    expect(md).not.toContain("🟢 LIVENESS");
  });
});

// --- snapshots --------------------------------------------------------------

describe("markdown surface", () => {
  for (const [name, vm] of FIXTURES) {
    it(`renders (${name})`, () => {
      expect(renderReportMarkdown(vm)).toMatchSnapshot();
    });
  }
});

describe("ANSI surface", () => {
  /** Escapes as tags, so the snapshot shows which role each run was painted. */
  const readable = (text: string) =>
    text
      .replace(/\x1b\[(\d+)m/g, (_, code) => (code === "0" ? "</>" : `<${code}>`))
      .replace(/<32>/g, "<green>")
      .replace(/<33>/g, "<amber>")
      .replace(/<31>/g, "<red>")
      .replace(/<90>/g, "<grey>");

  for (const [name, vm] of FIXTURES) {
    it(`paints the same layout (${name})`, () => {
      expect(readable(renderReportAnsi(vm))).toMatchSnapshot();
    });
  }
});
