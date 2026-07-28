/**
 * The report card — DEMO ONLY.
 *
 * The shipped card is `ReportView`. This one renders a `ReportViewModel` (the
 * real type) inside the fixture conversations, so the design review can judge a
 * report at panel width without seeding ClickHouse.
 *
 * It wears the SAME skin as the shipped card (`../../report-skin`), so the two
 * cannot drift apart visually — a review of this card is a review of the real
 * one. It reuses the production semantics too: the health message catalog for
 * every string, `sparklineFromSeries` for every trend. Only the *formatting* is
 * local, and only because the markdown renderer keeps its formatters private.
 *
 * What stays demo-only is behaviour: the footer never navigates, it hands the
 * label back to the host so the transcript can show what would have happened.
 */
import type {
  Finding,
  Metric,
  ReportViewModel,
  Unit,
} from "~/presenters/v3/reports/report-view-model";
import { healthMessages } from "~/presenters/v3/reports/health/health-messages";
import { sparklineFromSeries } from "~/presenters/v3/reports/renderMarkdown";
import {
  REPORT_SEVERITY_TONE,
  ReportActionButton,
  ReportActionNote,
  ReportActions,
  ReportBlock,
  ReportCommandLine,
  ReportEntity,
  ReportHeadline,
  ReportMeta,
  ReportRow,
  ReportRows,
  ReportRule,
  ReportSpark,
  ReportStatement,
  ReportSurface,
  ReportText,
  ReportValue,
} from "../../report-skin";

/** Footer codes that state an option rather than offer one — see `ReportView`. */
const NON_ACTION_CODES = new Set(["nothing_to_do", "do_nothing_drains", "region_failover"]);

// --- formatting -------------------------------------------------------------
// Local copies of the markdown renderer's private formatters. Kept in sync by
// eye for the demo; the real ReportView should share them properly (M2).

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  const m = s / 60;
  return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1)}m`;
}

function fmtValue(value: number, unit: Unit): string {
  switch (unit) {
    case "ms":
      return fmtDuration(value);
    case "ratio":
      return `${(value * 100).toFixed(1)}%`;
    case "perMin":
      return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(Math.round(value)).toLocaleString("en-US")}/min`;
    case "count":
    default:
      return Math.round(value).toLocaleString("en-US");
  }
}

function fmtCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Fill the `{token}` placeholders the message catalog leaves for the renderer. */
function fillTokens(text: string, tokens: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    tokens[key] === undefined ? whole : String(tokens[key])
  );
}

function metricTokens(vm: ReportViewModel, metric: Metric): Record<string, string | number> {
  return {
    value: metric.annotation?.value ?? metric.value,
    window: vm.windowMinutes,
    limit: metric.breakdown?.limit ?? "",
  };
}

function findingTokens(vm: ReportViewModel): Record<string, string | number> {
  const triggered = vm.metrics.find((m) => m.id === "triggered");
  const throughput = vm.metrics.find((m) => m.id === "throughput");
  const liveness = vm.metrics.find((m) => m.id === "liveness");
  return {
    mult: triggered?.delta?.mult ?? "",
    rate: Math.round(throughput?.breakdown?.done ?? 0),
    age: liveness ? fmtDuration(liveness.value) : "",
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// --- pieces ----------------------------------------------------------------

function MetricRow({ vm, metric }: { vm: ReportViewModel; metric: Metric }) {
  const spark = metric.series?.points.length ? sparklineFromSeries(metric.series.points) : "";
  const trailing = metric.annotation
    ? fillTokens(healthMessages.annotationMessage(metric.annotation.code), metricTokens(vm, metric))
    : metric.normal !== undefined
      ? `normal ~${fmtValue(metric.normal, metric.unit)}`
      : metric.series?.kind === "estimated"
        ? "estimated"
        : "";

  const composite = metric.unit === "perMin" && metric.breakdown?.done !== undefined;
  const tone = REPORT_SEVERITY_TONE[metric.severity];

  return (
    <ReportRow label={healthMessages.metricLabel(metric.id)}>
      <ReportValue tone={tone}>{fmtValue(metric.value, metric.unit)}</ReportValue>
      {spark ? <ReportSpark>{spark}</ReportSpark> : null}
      {metric.delta?.mult && metric.delta.mult > 1 ? (
        <ReportValue tone={metric.severity === "ok" ? "dimmed" : tone}>
          {metric.delta.dir === "up" ? "↑" : metric.delta.dir === "down" ? "↓" : ""}
          {metric.delta.mult}×
        </ReportValue>
      ) : null}
      {composite ? (
        <ReportValue tone="dimmed">
          ({fmtCount(metric.breakdown!.done!)} done · {fmtCount(metric.breakdown!.triggered ?? 0)}{" "}
          triggered)
        </ReportValue>
      ) : null}
      {trailing ? <span className="text-text-faint">{trailing}</span> : null}
    </ReportRow>
  );
}

function FindingSection({ vm, finding }: { vm: ReportViewModel; finding: Finding }) {
  const degraded = finding.severity !== "ok";
  const reason = healthMessages.findingReason(finding.type, finding.reason, {
    expanded: !degraded,
  });
  const tokens = findingTokens(vm);
  const metrics = finding.metricIds
    .map((id) => vm.metrics.find((m) => m.id === id))
    .filter((m): m is Metric => m !== undefined);

  return (
    <ReportBlock>
      <ReportStatement severity={finding.severity} tone={degraded ? "default" : "dimmed"}>
        <span className="text-text-dimmed">{finding.type}</span> {fillTokens(reason, tokens)}
        {finding.anomalyWindow?.touchesEnd ? ` (last ${finding.anomalyWindow.minutes} min)` : ""}
      </ReportStatement>

      {degraded ? (
        <div className="space-y-1.5 pl-6">
          {finding.read ? (
            <ReportText>
              read: {fillTokens(healthMessages.readMessage(finding.read), tokens)}
            </ReportText>
          ) : null}
          <ReportRows>
            {metrics.map((metric) => (
              <MetricRow key={metric.id} vm={vm} metric={metric} />
            ))}
          </ReportRows>
          {finding.attribution ? (
            <ReportText>
              worst {finding.attribution.dim}:{" "}
              <ReportEntity>{finding.attribution.key}</ReportEntity> —{" "}
              {Math.round(finding.attribution.share * 100)}% of {finding.attribution.of}
            </ReportText>
          ) : null}
          {(finding.exclusions ?? []).map((exclusion, i) => (
            <ReportText key={`x${i}`} tone="faint">
              {fillTokens(healthMessages.exclusionMessage(exclusion.code), {
                ...tokens,
                ...(exclusion.evidence ?? {}),
              })}
            </ReportText>
          ))}
          {(finding.observations ?? []).map((observation, i) => (
            <ReportText key={`o${i}`} tone="faint">
              {fillTokens(healthMessages.observationMessage(observation.code), {
                ...tokens,
                ...(observation.evidence ?? {}),
              })}
            </ReportText>
          ))}
        </div>
      ) : null}
    </ReportBlock>
  );
}

export function DemoReportCard({
  vm,
  /** Where the report came from, e.g. a `trigger://…/report/health` URI. */
  sourceUri,
  onAction,
}: {
  vm: ReportViewModel;
  sourceUri?: string;
  onAction?: (label: string, url?: string) => void;
}) {
  const tokens = findingTokens(vm);

  return (
    <ReportSurface>
      <ReportCommandLine>/report {vm.title}</ReportCommandLine>

      <ReportHeadline>
        {capitalize(vm.title)} · {vm.scope} · {vm.period}
        {vm.baselineLabel ? ` · ${vm.baselineLabel}` : ""}
      </ReportHeadline>

      <ReportBlock>
        {vm.summary.statements.map((statement, i) => (
          <ReportStatement key={i} severity={statement.severity}>
            {healthMessages.statementMessage(
              statement.findingType,
              statement.severity,
              statement.reason
            )}
          </ReportStatement>
        ))}
      </ReportBlock>

      <ReportRule />

      <div className="space-y-2.5">
        {vm.findings.map((finding, i) => (
          <FindingSection key={i} vm={vm} finding={finding} />
        ))}
      </div>

      {vm.footer.length > 0 ? (
        <>
          <ReportRule />
          <ReportActions>
            {vm.footer.map((entry, i) => {
              const label = fillTokens(healthMessages.actionMessage(entry.code), {
                ...tokens,
                value: entry.value ?? "",
              });
              if (NON_ACTION_CODES.has(entry.code)) {
                return <ReportActionNote key={i}>{label}</ReportActionNote>;
              }
              const url = vm.links.find((link) => link.key === entry.link)?.url;
              // Demo mode: even a docs action stays a click the host intercepts,
              // so the fixture chat can narrate it instead of leaving the page.
              return (
                <ReportActionButton
                  key={i}
                  label={label}
                  tone={url ? "docs" : "support"}
                  onClick={() => onAction?.(label, url)}
                />
              );
            })}
          </ReportActions>
        </>
      ) : null}

      {sourceUri ? <ReportMeta>{sourceUri}</ReportMeta> : null}
    </ReportSurface>
  );
}
