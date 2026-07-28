/**
 * The report card — DEMO ONLY.
 *
 * The real card is `ReportView`. This one renders a `ReportViewModel` (the real
 * type) as a panel-width card so a design review can settle the layout question
 * the markdown renderer can't answer: what a report looks like inside a 380px
 * chat panel.
 *
 * It reuses the production semantics wherever they exist — the health message
 * catalog for every string, the shared sections, metric row and sparkline from
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
import {
  ReportBody,
  ReportCard,
  ReportFindingLine,
  ReportFooterAction,
  ReportFooterLine,
  ReportFooterLink,
  ReportFooterNote,
  ReportHeaderLine,
  ReportHeadline,
  ReportMetricList,
  ReportMetricRow,
  ReportNoteBlock,
  ReportProse,
  ReportProvenance,
  ReportSeverityIcon,
  reportDelta,
} from "../../report-sparkline";

/** Footer codes that state an option rather than offer one — plain text, not a button. */
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

// --- pieces ----------------------------------------------------------------

function MetricRow({
  vm,
  metric,
  anomalyMinutes,
  hero,
}: {
  vm: ReportViewModel;
  metric: Metric;
  anomalyMinutes?: number;
  /** The metric that explains the finding: its annotation is spelled out inline. */
  hero?: boolean;
}) {
  const annotation = metric.annotation
    ? fillTokens(healthMessages.annotationMessage(metric.annotation.code), metricTokens(vm, metric))
    : undefined;
  const note = annotation
    ? annotation
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
      subRows={
        composite
          ? [
              { label: "done", value: fmtCount(metric.breakdown!.done!) },
              { label: "triggered", value: fmtCount(metric.breakdown!.triggered ?? 0) },
            ]
          : undefined
      }
      delta={reportDelta(metric.delta, metric.normal !== undefined)}
      note={hero && annotation ? undefined : note}
      heroNote={hero ? annotation : undefined}
      series={metric.series?.points}
      windowMinutes={vm.windowMinutes}
      anomalyMinutes={anomalyMinutes}
      formatPoint={(value) => fmtValue(value, metric.unit)}
    />
  );
}

/** A finding's evidence: the metric grid, then "why:" — who owns it, what it isn't. */
function FindingBody({
  vm,
  finding,
  tokens,
}: {
  vm: ReportViewModel;
  finding: Finding;
  tokens: Record<string, string | number>;
}) {
  const metrics = finding.metricIds
    .map((id) => vm.metrics.find((m) => m.id === id))
    .filter((m): m is Metric => m !== undefined);

  // The anomaly window describes the finding's *driving* metric — the first id,
  // since degraded findings list theirs in causal order.
  const anomalyMinutes = finding.anomalyWindow?.touchesEnd
    ? finding.anomalyWindow.minutes
    : undefined;

  return (
    <div className="space-y-2.5">
      <ReportMetricList>
        {metrics.map((metric, i) => (
          <MetricRow
            key={metric.id}
            vm={vm}
            metric={metric}
            anomalyMinutes={i === 0 ? anomalyMinutes : undefined}
            hero={i === 0}
          />
        ))}
      </ReportMetricList>

      <ReportNoteBlock label="why:">
        {finding.attribution ? (
          <ReportProse
            text={`${Math.round(finding.attribution.share * 100)}% of ${
              finding.attribution.of
            } is ${finding.attribution.key}`}
            entities={[finding.attribution.key]}
          />
        ) : null}
        {(finding.exclusions ?? []).map((exclusion, i) => (
          <ReportProse
            key={`x${i}`}
            text={fillTokens(healthMessages.exclusionMessage(exclusion.code), {
              ...tokens,
              ...(exclusion.evidence ?? {}),
            })}
          />
        ))}
        {(finding.observations ?? []).map((observation, i) => (
          <ReportProse
            key={`o${i}`}
            text={fillTokens(healthMessages.observationMessage(observation.code), {
              ...tokens,
              ...(observation.evidence ?? {}),
            })}
          />
        ))}
      </ReportNoteBlock>
    </div>
  );
}

/** The finding the headline speaks for: the first one at the report's severity. */
function heroIndexOf(vm: ReportViewModel): number {
  const index = vm.findings.findIndex((finding) => finding.severity === vm.summary.severity);
  return index === -1 ? 0 : index;
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
  const severity = vm.summary.severity;

  const heroIndex = heroIndexOf(vm);
  const hero = vm.findings[heroIndex] as Finding | undefined;
  const otherFindings = vm.findings.filter((_, i) => i !== heroIndex);
  const heroStatement = vm.summary.statements.find((s) => s.findingType === hero?.type);

  // The headline speaks for the hero finding. When its statement carries a reason
  // of its own (stale telemetry) that statement IS the whole sentence.
  const headlinePhrase = hero
    ? healthMessages.statementMessage(hero.type, hero.severity, heroStatement?.reason)
    : healthMessages.statementMessage(vm.title, severity);
  const headlineContinuation =
    hero && !heroStatement?.reason
      ? fillTokens(
          healthMessages.findingReason(hero.type, hero.reason, {
            expanded: hero.severity === "ok",
          }),
          tokens
        ) +
        (hero.anomalyWindow?.touchesEnd ? ` for the last ${hero.anomalyWindow.minutes} min` : "")
      : undefined;

  const orphanStatements = vm.summary.statements.filter(
    (statement) => !vm.findings.some((finding) => finding.type === statement.findingType)
  );

  const reads = (hero ? [hero, ...otherFindings] : otherFindings)
    .filter((finding) => finding.read !== undefined)
    .map((finding) => fillTokens(healthMessages.readMessage(finding.read!), tokens));

  const footerLinkKeys = new Set(vm.footer.map((entry) => entry.link).filter(Boolean));

  return (
    <ReportCard>
      <ReportHeaderLine
        name={vm.title}
        meta={`${vm.scope} · ${vm.period}${vm.baselineLabel ? ` · ${vm.baselineLabel}` : ""}`}
      />

      <ReportBody>
        <ReportHeadline
          severity={severity}
          phrase={headlinePhrase}
          continuation={headlineContinuation}
        />

        {hero ? <FindingBody vm={vm} finding={hero} tokens={tokens} /> : null}

        {otherFindings.length > 0 || orphanStatements.length > 0 ? (
          <div className="space-y-2.5">
            {otherFindings.map((finding, i) => {
              const degraded = finding.severity !== "ok";
              return (
                <div key={`${finding.type}-${i}`} className="space-y-2">
                  <ReportFindingLine
                    severity={finding.severity}
                    type={finding.type}
                    bright={degraded}
                    text={
                      fillTokens(
                        healthMessages.findingReason(finding.type, finding.reason, {
                          expanded: !degraded,
                        }),
                        tokens
                      ) +
                      (finding.anomalyWindow?.touchesEnd
                        ? ` (last ${finding.anomalyWindow.minutes} min)`
                        : "")
                    }
                  />
                  {degraded ? (
                    <div className="pl-[1.375rem]">
                      <FindingBody vm={vm} finding={finding} tokens={tokens} />
                    </div>
                  ) : null}
                </div>
              );
            })}
            {orphanStatements.map((statement, i) => (
              <p key={`s${i}`} className="flex items-center gap-1.5 text-sm">
                <ReportSeverityIcon severity={statement.severity} />
                <span className="text-text-dimmed">
                  {healthMessages.statementMessage(
                    statement.findingType,
                    statement.severity,
                    statement.reason
                  )}
                </span>
              </p>
            ))}
          </div>
        ) : null}

        <ReportNoteBlock label="read:">
          {reads.map((read, i) => (
            <ReportProse key={i} text={read} />
          ))}
        </ReportNoteBlock>

        <ReportFooterLine>
          {vm.footer.map((entry, i) => {
            const label = fillTokens(healthMessages.actionMessage(entry.code), {
              ...tokens,
              value: entry.value ?? "",
            });
            const url = vm.links.find((link) => link.key === entry.link)?.url;
            if (NON_ACTION_CODES.has(entry.code)) {
              return <ReportFooterNote key={i}>{label}</ReportFooterNote>;
            }
            // Footer actions are link text — the footer reads as one sentence
            // after the arrow. Demo mode never navigates: clicking hands the
            // label back so the transcript can show what would happen.
            return (
              <ReportFooterAction key={i} onClick={() => onAction?.(label, url)}>
                {label}
              </ReportFooterAction>
            );
          })}
          {/* Docs the report cites — reading matter, so links rather than buttons.
              Demo mode has no host to resolve `trigger://` URIs, so only real URLs. */}
          {vm.links
            .filter((link) => !footerLinkKeys.has(link.key) && /^https?:\/\//i.test(link.url))
            .map((link) => (
              <ReportFooterLink key={link.key} href={link.url} external>
                {link.label}
              </ReportFooterLink>
            ))}
        </ReportFooterLine>

        {sourceUri ? <ReportProvenance uri={sourceUri} /> : null}
      </ReportBody>
    </ReportCard>
  );
}
