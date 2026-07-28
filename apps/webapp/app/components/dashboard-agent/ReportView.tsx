/**
 * The report card — the panel's rendering of a `report` view block.
 *
 * A report is a snapshot of a `ReportViewModel`: numbers plus message *codes*,
 * never prose. Every string on this card is resolved through the report's own
 * message catalog (`report-messages.ts`), which is also what the markdown and
 * ANSI renderers use — so the chat card, the CLI and the agent's own grounding
 * can't drift into three different vocabularies. Layout is inherited from the
 * design-reviewed demo card (`demo/components/DemoReportCard.tsx`), which stays
 * as the mockup it is.
 *
 * PURE COMPONENT, on purpose: props in, no Remix hooks, no loader data, no
 * router context. That's what lets it render identically in the panel, in the
 * storybook gallery, and (later) in any other host. Two consequences:
 *
 * - `trigger://` URIs are resolved by the HOST via the `resolveUri` prop. The
 *   card knows a URI is a resource pointer; only the host knows the environment
 *   it should resolve against.
 * - Footer actions don't navigate. They emit an `AgentIntent` and the host
 *   decides whether to honour it — the same contract the rest of the agent uses.
 */
import {
  isTriggerUri,
  type AgentIntent,
  type ReportFindingPayload,
  type ReportMetricPayload,
  type ReportUnit,
  type ReportViewModelPayload,
  type TriggerUri,
} from "@internal/dashboard-agent-contracts";
import { Badge } from "~/components/primitives/Badge";
// Imported for its registration side effect as much as its value: each report's
// catalog registers itself under the report's title on import.
import { healthMessages } from "~/presenters/v3/reports/health/health-messages";
import { type ReportMessages } from "~/presenters/v3/reports/report-messages";
import { cn } from "~/utils/cn";
import { reportIsTrustworthy } from "./report-block-adapter";
import {
  ReportMetricRow,
  ReportSeverityIcon,
  SEVERITY_BADGE,
  SEVERITY_TEXT,
} from "./report-sparkline";

export type ResolvedUri = { label: string; url: string };

/**
 * Footer codes that state an option rather than offer an action ("nothing to do",
 * "or do nothing — the backlog drains in ~26 min"). They render as a line of
 * text: making them buttons would invite a click that does nothing.
 */
const NON_ACTION_CODES = new Set(["nothing_to_do", "do_nothing_drains", "region_failover"]);

/** How often a recovery watch polls, and how long it lives. Aggregate conditions floor at 5m. */
const RECOVERY_WATCH = { checkEveryMinutes: 5, maxHours: 6 } as const;

// --- messages ---------------------------------------------------------------

/**
 * Codes resolve through the report's own catalog. A report with no registered
 * catalog (an old transcript, a report that hasn't shipped its messages) falls
 * back to showing the raw codes — thin, but never a crash and never invented
 * prose.
 */
const PASSTHROUGH_MESSAGES: ReportMessages = {
  metricLabel: (id) => id,
  findingReason: (_type, reason) => reason,
  readMessage: (code) => code,
  exclusionMessage: (code) => code,
  observationMessage: (code) => code,
  annotationMessage: (code) => code,
  statementMessage: (findingType, severity) => `${findingType} ${severity}`,
  actionMessage: (code) => code,
};

const CATALOGS: Record<string, ReportMessages> = { health: healthMessages };

function messagesFor(title: string): ReportMessages {
  return CATALOGS[title] ?? PASSTHROUGH_MESSAGES;
}

// --- formatting -------------------------------------------------------------
// The markdown renderer keeps its formatters private, so these mirror them. If
// they ever become shared, this is the block that goes.

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  const m = s / 60;
  return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1)}m`;
}

function fmtValue(value: number, unit: ReportUnit): string {
  switch (unit) {
    case "ms":
      return fmtDuration(value);
    case "ratio":
      return `${(value * 100).toFixed(1)}%`;
    case "perMin":
      return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(Math.round(value)).toLocaleString(
        "en-US"
      )}/min`;
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

function metricTokens(
  vm: ReportViewModelPayload,
  metric: ReportMetricPayload
): Record<string, string | number> {
  return {
    value: metric.annotation?.value ?? metric.value,
    window: vm.windowMinutes,
    limit: metric.breakdown?.limit ?? "",
  };
}

function findingTokens(vm: ReportViewModelPayload): Record<string, string | number> {
  const metric = (id: string) => vm.metrics.find((m) => m.id === id);
  const triggered = metric("triggered");
  const throughput = metric("throughput");
  const liveness = metric("liveness");
  return {
    mult: triggered?.delta?.mult ?? "",
    rate: Math.round(throughput?.breakdown?.done ?? 0),
    age: liveness ? fmtDuration(liveness.value) : "",
  };
}

// --- links ------------------------------------------------------------------

/**
 * What a `vm.links` entry points at. A report link is either an external doc URL
 * or a `trigger://` URI naming a resource in the environment — the card treats
 * them differently because only the host can turn a URI into a route.
 */
type LinkTarget =
  | { kind: "none" }
  | { kind: "external"; url: string }
  | { kind: "resource"; uri: TriggerUri; resolved: ResolvedUri | null };

function classifyLink(
  url: string | undefined,
  resolveUri: ((uri: string) => ResolvedUri | null) | undefined
): LinkTarget {
  if (!url) return { kind: "none" };
  if (isTriggerUri(url)) return { kind: "resource", uri: url, resolved: resolveUri?.(url) ?? null };
  if (/^https?:\/\//i.test(url)) return { kind: "external", url };
  return { kind: "none" };
}

const ACTION_CLASS =
  "inline-flex items-center rounded border border-border-bright bg-background-bright px-2.5 py-1 text-sm text-text-bright transition-colors hover:border-border-brightest hover:bg-background-hover";

/**
 * One footer action. External docs are a real link; anything in-app becomes a
 * `navigate` intent, and an action with no target at all becomes an `ask` so the
 * user can still pull the "how" out of the agent.
 */
function ActionButton({
  label,
  target,
  onIntent,
}: {
  label: string;
  target: LinkTarget;
  onIntent?: (intent: AgentIntent) => void;
}) {
  if (target.kind === "external") {
    return (
      <a href={target.url} target="_blank" rel="noreferrer" className={ACTION_CLASS}>
        {label}
      </a>
    );
  }

  const intent: AgentIntent =
    target.kind === "resource"
      ? { kind: "navigate", target: target.uri }
      : { kind: "ask", prompt: `How do I ${lowerFirst(label)}?` };

  if (!onIntent) return <span className="text-sm text-text-dimmed">{label}</span>;

  return (
    <button type="button" onClick={() => onIntent(intent)} className={ACTION_CLASS}>
      {label}
    </button>
  );
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// --- pieces -----------------------------------------------------------------

function MetricRow({
  vm,
  metric,
  messages,
  anomalyMinutes,
}: {
  vm: ReportViewModelPayload;
  metric: ReportMetricPayload;
  messages: ReportMessages;
  anomalyMinutes?: number;
}) {
  const note = metric.annotation
    ? fillTokens(messages.annotationMessage(metric.annotation.code), metricTokens(vm, metric))
    : metric.normal !== undefined
      ? `normal ~${fmtValue(metric.normal, metric.unit)}`
      : metric.series?.kind === "estimated"
        ? "Estimated from a proxy signal, so read it as a shape, not a number."
        : undefined;

  const composite = metric.unit === "perMin" && metric.breakdown?.done !== undefined;

  return (
    <ReportMetricRow
      label={messages.metricLabel(metric.id)}
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

function FindingSection({
  vm,
  finding,
  messages,
  tokens,
}: {
  vm: ReportViewModelPayload;
  finding: ReportFindingPayload;
  messages: ReportMessages;
  tokens: Record<string, string | number>;
}) {
  const degraded = finding.severity !== "ok";
  const reason = messages.findingReason(finding.type, finding.reason, { expanded: !degraded });
  const metrics = finding.metricIds
    .map((id) => vm.metrics.find((m) => m.id === id))
    .filter((m): m is ReportMetricPayload => m !== undefined);

  // The anomaly window describes the finding's *driving* metric — the first id,
  // since degraded findings list theirs in causal order — so only that one
  // sparkline highlights it.
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
        // Indented to clear the severity icon and its gap, so the metric grid
        // starts under the finding's text.
        <div className="space-y-1.5 pl-[1.375rem]">
          {finding.read ? (
            <p className="text-sm text-text-dimmed">
              read: {fillTokens(messages.readMessage(finding.read), tokens)}
            </p>
          ) : null}
          <ul className="space-y-1">
            {metrics.map((metric, i) => (
              <MetricRow
                key={metric.id}
                vm={vm}
                metric={metric}
                messages={messages}
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
              {fillTokens(messages.exclusionMessage(exclusion.code), {
                ...tokens,
                ...(exclusion.evidence ?? {}),
              })}
            </p>
          ))}
          {(finding.observations ?? []).map((observation, i) => (
            <p key={`o${i}`} className="text-sm text-text-faint">
              {fillTokens(messages.observationMessage(observation.code), {
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

// --- card -------------------------------------------------------------------

export function ReportView({
  vm,
  /** The `trigger://…/report/{key}` this snapshot came from, shown as its provenance. */
  reportUri,
  /** Emitted when the user clicks a footer action. The host decides what to do. */
  onIntent,
  /** Host-supplied `trigger://` resolver. Without one, resource links stay intents. */
  resolveUri,
}: {
  vm: ReportViewModelPayload;
  reportUri?: string;
  onIntent?: (intent: AgentIntent) => void;
  resolveUri?: (uri: string) => ResolvedUri | null;
}) {
  const messages = messagesFor(vm.title);
  const tokens = findingTokens(vm);
  const trustworthy = reportIsTrustworthy(vm);
  const severity = vm.summary.severity;
  const linkByKey = (key: string | undefined) =>
    key === undefined ? undefined : vm.links.find((link) => link.key === key)?.url;

  // "Tell me when this recovers" — only offered when there is something to
  // recover from, and only for the health report, whose watch kind exists.
  const recoveryWatch: AgentIntent | null =
    vm.title === "health" && (severity === "warn" || severity === "crit")
      ? {
          kind: "watch",
          spec: {
            kind: "health_recovery",
            report: "health",
            fromSeverity: severity,
            note: `${vm.scope} health back to normal`,
            ...RECOVERY_WATCH,
          },
        }
      : null;

  return (
    <div className="overflow-hidden rounded-lg border border-border-bright bg-background-dimmed">
      <div className="flex flex-wrap items-center gap-2 border-b border-grid-bright bg-background-bright px-3 py-2">
        <span className="text-xs font-medium capitalize text-text-dimmed">{vm.title} report</span>
        <Badge variant="small" className={SEVERITY_BADGE[severity]}>
          {vm.scope}
        </Badge>
        {trustworthy ? null : (
          <Badge variant="small" className="border-warning/40 text-warning">
            stale data
          </Badge>
        )}
        <span className="ml-auto text-xs text-text-dimmed">
          {vm.period}
          {vm.baselineLabel ? ` · ${vm.baselineLabel}` : ""}
        </span>
      </div>

      <div className={cn("space-y-3 px-3 py-3", trustworthy ? undefined : "opacity-80")}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {vm.summary.statements.map((statement, i) => (
            <span key={i} className="flex items-center gap-1.5 text-sm">
              <ReportSeverityIcon severity={statement.severity} />
              <span className={SEVERITY_TEXT[statement.severity]}>
                {messages.statementMessage(
                  statement.findingType,
                  statement.severity,
                  statement.reason
                )}
              </span>
            </span>
          ))}
        </div>

        {trustworthy ? null : (
          <p className="text-sm text-warning">
            The telemetry behind this report is stale, so the numbers below are informational only.
          </p>
        )}

        <div className="space-y-2.5 border-t border-grid-bright pt-2.5">
          {vm.findings.map((finding, i) => (
            <FindingSection
              key={`${finding.type}-${i}`}
              vm={vm}
              finding={finding}
              messages={messages}
              tokens={tokens}
            />
          ))}
        </div>

        {vm.footer.length > 0 || recoveryWatch ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-grid-bright pt-2.5">
            {vm.footer.map((entry, i) => {
              const label = fillTokens(messages.actionMessage(entry.code), {
                ...tokens,
                value: entry.value ?? "",
              });
              if (NON_ACTION_CODES.has(entry.code)) {
                return (
                  <span key={i} className="text-sm text-text-dimmed">
                    {label}
                  </span>
                );
              }
              return (
                <ActionButton
                  key={i}
                  label={label}
                  target={classifyLink(linkByKey(entry.link), resolveUri)}
                  onIntent={onIntent}
                />
              );
            })}
            {recoveryWatch && onIntent ? (
              <button
                type="button"
                onClick={() => onIntent(recoveryWatch)}
                className={ACTION_CLASS}
              >
                Watch for recovery
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Resources the report cites, resolved to dashboard links by the host. */}
        {vm.links.length > 0 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {vm.links.map((link) => {
              const target = classifyLink(link.url, resolveUri);
              if (target.kind === "external") {
                return (
                  <a
                    key={link.key}
                    href={target.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-500 transition hover:text-indigo-400"
                  >
                    {link.label}
                  </a>
                );
              }
              if (target.kind === "resource" && target.resolved) {
                return (
                  <a
                    key={link.key}
                    href={target.resolved.url}
                    className="text-indigo-500 transition hover:text-indigo-400"
                  >
                    {target.resolved.label}
                  </a>
                );
              }
              return null;
            })}
          </div>
        ) : null}

        {reportUri ? (
          <div className="break-all font-mono text-[10px] text-text-faint">{reportUri}</div>
        ) : null}
      </div>
    </div>
  );
}
