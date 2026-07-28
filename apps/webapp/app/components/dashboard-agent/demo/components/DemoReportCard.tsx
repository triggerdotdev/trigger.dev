/**
 * The report card — DEMO ONLY.
 *
 * M2 owns the real `ReportView`. Until then this renders a `ReportViewModel`
 * (the real type) as a panel-width card so the design review can settle the
 * layout question the markdown renderer can't answer: what a report looks like
 * inside a 380px chat panel.
 *
 * It reuses the production semantics wherever they exist — the health message
 * catalog for every string, the shared metric row and sparkline from
 * `report-sparkline.tsx` for the layout — so the card holds no report vocabulary
 * and no layout of its own. Only the *formatting* is local, and only because the
 * markdown renderer keeps its formatters private.
 */
import type {
  Finding,
  Metric,
  ReportViewModel,
  Unit,
} from "~/presenters/v3/reports/report-view-model";
import { healthMessages } from "~/presenters/v3/reports/health/health-messages";
import { Badge } from "~/components/primitives/Badge";
import { cn } from "~/utils/cn";
import {
  ReportMetricRow,
  ReportSeverityIcon,
  SEVERITY_BADGE,
  SEVERITY_TEXT,
} from "../../report-sparkline";

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

// --- pieces ----------------------------------------------------------------

function fmtCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function MetricRow({
  vm,
  metric,
  anomalyMinutes,
}: {
  vm: ReportViewModel;
  metric: Metric;
  anomalyMinutes?: number;
}) {
  const note = metric.annotation
    ? fillTokens(healthMessages.annotationMessage(metric.annotation.code), metricTokens(vm, metric))
    : metric.normal !== undefined
      ? `normal ~${fmtValue(metric.normal, metric.unit)}`
      : metric.series?.kind === "estimated"
        ? "Estimated from a proxy signal, so read it as a shape, not a number."
        : undefined;

  const composite = metric.unit === "perMin" && metric.breakdown?.done !== undefined;

  return (
    <ReportMetricRow
      label={healthMessages.metricLabel(metric.id)}
      value={fmtValue(metric.value, metric.unit)}
      severity={metric.severity}
      breakdown={
        composite
          ? `${fmtCount(metric.breakdown!.done!)} done · ${fmtCount(
              metric.breakdown!.triggered ?? 0
            )} triggered`
          : undefined
      }
      delta={
        metric.delta?.mult && metric.delta.mult > 1
          ? `${metric.delta.dir === "up" ? "↑" : metric.delta.dir === "down" ? "↓" : ""}${
              metric.delta.mult
            }×`
          : undefined
      }
      note={note}
      series={metric.series?.points}
      windowMinutes={vm.windowMinutes}
      anomalyMinutes={anomalyMinutes}
      formatPoint={(value) => fmtValue(value, metric.unit)}
    />
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

  // The anomaly window describes the finding's *driving* metric — the first id,
  // since degraded findings list theirs in causal order.
  const anomalyMinutes = finding.anomalyWindow?.touchesEnd
    ? finding.anomalyWindow.minutes
    : undefined;

  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2">
        <ReportSeverityIcon severity={finding.severity} className="mt-0.5" />
        <span className="mt-px text-xs uppercase tracking-wide text-text-dimmed">
          {finding.type}
        </span>
        <span className={cn("text-sm", degraded ? "text-text-bright" : "text-text-dimmed")}>
          {fillTokens(reason, tokens)}
          {finding.anomalyWindow?.touchesEnd ? ` (last ${finding.anomalyWindow.minutes} min)` : ""}
        </span>
      </div>

      {degraded ? (
        <div className="space-y-1.5 pl-[1.375rem]">
          {finding.read ? (
            <p className="text-sm text-text-dimmed">
              read: {fillTokens(healthMessages.readMessage(finding.read), tokens)}
            </p>
          ) : null}
          <ul className="space-y-1">
            {metrics.map((metric, i) => (
              <MetricRow
                key={metric.id}
                vm={vm}
                metric={metric}
                anomalyMinutes={i === 0 ? anomalyMinutes : undefined}
              />
            ))}
          </ul>
          {finding.attribution ? (
            <p className="text-sm text-text-dimmed">
              worst {finding.attribution.dim}:{" "}
              <span className="font-mono text-text-bright">{finding.attribution.key}</span> —{" "}
              {Math.round(finding.attribution.share * 100)}% of {finding.attribution.of}
            </p>
          ) : null}
          {(finding.exclusions ?? []).map((exclusion, i) => (
            <p key={`x${i}`} className="text-sm text-text-faint">
              {fillTokens(healthMessages.exclusionMessage(exclusion.code), {
                ...tokens,
                ...(exclusion.evidence ?? {}),
              })}
            </p>
          ))}
          {(finding.observations ?? []).map((observation, i) => (
            <p key={`o${i}`} className="text-sm text-text-faint">
              {fillTokens(healthMessages.observationMessage(observation.code), {
                ...tokens,
                ...(observation.evidence ?? {}),
              })}
            </p>
          ))}
        </div>
      ) : null}
    </div>
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
    <div className="overflow-hidden rounded-lg border border-border-bright bg-background-dimmed">
      <div className="flex flex-wrap items-center gap-2 border-b border-grid-bright bg-background-bright px-3 py-2">
        <span className="text-xs font-medium capitalize text-text-dimmed">{vm.title} report</span>
        <Badge variant="small" className={SEVERITY_BADGE[vm.summary.severity]}>
          {vm.scope}
        </Badge>
        <span className="ml-auto text-xs text-text-dimmed">
          {vm.period}
          {vm.baselineLabel ? ` · ${vm.baselineLabel}` : ""}
        </span>
      </div>

      <div className="space-y-3 px-3 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {vm.summary.statements.map((statement, i) => (
            <span key={i} className="flex items-center gap-1.5 text-sm">
              <ReportSeverityIcon severity={statement.severity} />
              <span className={SEVERITY_TEXT[statement.severity]}>
                {healthMessages.statementMessage(
                  statement.findingType,
                  statement.severity,
                  statement.reason
                )}
              </span>
            </span>
          ))}
        </div>

        <div className="space-y-2.5 border-t border-grid-bright pt-2.5">
          {vm.findings.map((finding, i) => (
            <FindingSection key={i} vm={vm} finding={finding} />
          ))}
        </div>

        {vm.footer.length > 0 ? (
          <div className="flex flex-wrap gap-2 border-t border-grid-bright pt-2.5">
            {vm.footer.map((entry, i) => {
              const label = fillTokens(healthMessages.actionMessage(entry.code), {
                ...tokens,
                value: entry.value ?? "",
              });
              const url = vm.links.find((link) => link.key === entry.link)?.url;
              // Demo mode: the footer never navigates. Clicking hands the label
              // back to the host so the transcript can show what would happen.
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onAction?.(label, url)}
                  className="inline-flex items-center rounded border border-border-bright bg-background-bright px-2.5 py-1 text-sm text-text-bright transition-colors hover:border-border-brightest hover:bg-background-hover"
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}

        {sourceUri ? (
          <div className="break-all font-mono text-[10px] text-text-faint">{sourceUri}</div>
        ) : null}
      </div>
    </div>
  );
}
