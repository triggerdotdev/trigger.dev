/**
 * The report card — the panel's rendering of a `report` view block.
 *
 * A report is a snapshot of a `ReportViewModel`: numbers plus message *codes*,
 * never prose. Every string on this card is resolved through the report's own
 * message catalog (`report-messages.ts`), which is also what the markdown and
 * ANSI renderers use — so the chat card, the CLI and the agent's own grounding
 * can't drift into three different vocabularies.
 *
 * The LOOK lives in `report-skin.tsx` — the terminal skin (monospace body, fixed
 * label column, left-aligned sparklines, colour on values not on sentences, real
 * buttons in the footer). This file decides *what* a report says; the skin
 * decides how a report looks, and `demo/components/DemoReportCard.tsx` wears the
 * same skin so a design review of one holds for the other.
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
// Imported for its registration side effect as much as its value: each report's
// catalog registers itself under the report's title on import.
import { healthMessages } from "~/presenters/v3/reports/health/health-messages";
import { type ReportMessages } from "~/presenters/v3/reports/report-messages";
import { sparklineFromSeries } from "~/presenters/v3/reports/renderMarkdown";
import { reportIsTrustworthy } from "./report-block-adapter";
import {
  REPORT_SEVERITY_TONE,
  ReportActionButton,
  ReportActionNote,
  ReportActions,
  ReportBlock,
  ReportCommandLine,
  ReportEntity,
  ReportHeadline,
  ReportLink,
  ReportMeta,
  ReportNotice,
  ReportRow,
  ReportRows,
  ReportRule,
  ReportSpark,
  ReportStatement,
  ReportSurface,
  ReportText,
  ReportValue,
  type ReportActionTone,
} from "./report-skin";

export type ResolvedUri = { label: string; url: string };

/**
 * Footer codes that state an option rather than offer an action ("nothing to do",
 * "or do nothing — the backlog drains in ~26 min"). They render as a line of
 * text: making them buttons would invite a click that does nothing.
 */
const NON_ACTION_CODES = new Set(["nothing_to_do", "do_nothing_drains", "region_failover"]);

/**
 * Codes whose action removes or stops work. Matched by verb rather than listed,
 * so a report shipping `cancel_*` / `purge_*` gets the danger button for free.
 */
const DESTRUCTIVE_CODE = /^(cancel|purge|delete|drop|pause|stop)_/;

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

/**
 * One footer action, as a real button. External docs are a link button; anything
 * in-app becomes a `navigate` intent, and an action with no target at all becomes
 * an `ask` so the user can still pull the "how" out of the agent.
 *
 * The variant follows what the action does, not where it sits: navigation is the
 * primary (violet) action, docs get the docs treatment, a destructive code gets
 * danger, and asking the agent gets the secondary.
 */
function ActionButton({
  code,
  label,
  target,
  onIntent,
}: {
  code: string;
  label: string;
  target: LinkTarget;
  onIntent?: (intent: AgentIntent) => void;
}) {
  const destructive = DESTRUCTIVE_CODE.test(code);

  if (target.kind === "external") {
    return (
      <ReportActionButton label={label} tone={destructive ? "danger" : "docs"} href={target.url} />
    );
  }

  const intent: AgentIntent =
    target.kind === "resource"
      ? { kind: "navigate", target: target.uri }
      : { kind: "ask", prompt: `How do I ${lowerFirst(label)}?` };

  const tone: ReportActionTone = destructive
    ? "danger"
    : target.kind === "resource"
      ? "navigate"
      : "support";

  // Without a host to receive the intent there is nothing to click, so it stops
  // being a button rather than becoming a dead one.
  if (!onIntent) return <ReportActionNote>{label}</ReportActionNote>;

  return <ReportActionButton label={label} tone={tone} onClick={() => onIntent(intent)} />;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// --- pieces -----------------------------------------------------------------

function MetricRow({
  vm,
  metric,
  messages,
}: {
  vm: ReportViewModelPayload;
  metric: ReportMetricPayload;
  messages: ReportMessages;
}) {
  const spark = metric.series?.points.length ? sparklineFromSeries(metric.series.points) : "";
  const trailing = metric.annotation
    ? fillTokens(messages.annotationMessage(metric.annotation.code), metricTokens(vm, metric))
    : metric.normal !== undefined
      ? `normal ~${fmtValue(metric.normal, metric.unit)}`
      : metric.series?.kind === "estimated"
        ? "estimated"
        : "";

  const composite = metric.unit === "perMin" && metric.breakdown?.done !== undefined;
  const tone = REPORT_SEVERITY_TONE[metric.severity];

  return (
    <ReportRow label={messages.metricLabel(metric.id)}>
      <ReportValue tone={tone}>{fmtValue(metric.value, metric.unit)}</ReportValue>
      {/* The sparkline sits immediately after the value, still in the content
          column, so every trend on the card starts at the same x. */}
      {spark ? <ReportSpark>{spark}</ReportSpark> : null}
      {metric.delta?.mult && metric.delta.mult > 1 ? (
        // A delta only earns a colour when the metric it belongs to is degraded.
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

  return (
    <ReportBlock>
      <ReportStatement severity={finding.severity} tone={degraded ? "default" : "dimmed"}>
        <span className="text-text-dimmed">{finding.type}</span> {fillTokens(reason, tokens)}
        {finding.anomalyWindow?.touchesEnd ? ` (last ${finding.anomalyWindow.minutes} min)` : ""}
      </ReportStatement>

      {degraded ? (
        // Indented to the statement's text, so the icon column stays the card's
        // only left edge for severity.
        <div className="space-y-1.5 pl-6">
          {finding.read ? (
            <ReportText>read: {fillTokens(messages.readMessage(finding.read), tokens)}</ReportText>
          ) : null}
          <ReportRows>
            {metrics.map((metric) => (
              <MetricRow key={metric.id} vm={vm} metric={metric} messages={messages} />
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
              {fillTokens(messages.exclusionMessage(exclusion.code), {
                ...tokens,
                ...(exclusion.evidence ?? {}),
              })}
            </ReportText>
          ))}
          {(finding.observations ?? []).map((observation, i) => (
            <ReportText key={`o${i}`} tone="faint">
              {fillTokens(messages.observationMessage(observation.code), {
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
    <ReportSurface dimmed={!trustworthy}>
      {/* The command that produced this, so the card reads as an answer. */}
      <ReportCommandLine>/report {vm.title}</ReportCommandLine>

      <ReportHeadline>
        {capitalize(vm.title)} · {vm.scope} · {vm.period}
        {vm.baselineLabel ? ` · ${vm.baselineLabel}` : ""}
      </ReportHeadline>

      <ReportBlock>
        {vm.summary.statements.map((statement, i) => (
          <ReportStatement key={i} severity={statement.severity}>
            {messages.statementMessage(statement.findingType, statement.severity, statement.reason)}
          </ReportStatement>
        ))}
      </ReportBlock>

      {trustworthy ? null : (
        <ReportNotice severity="warn">
          The telemetry behind this report is stale, so the numbers below are informational only.
        </ReportNotice>
      )}

      <ReportRule />

      <div className="space-y-2.5">
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
        <>
          <ReportRule />
          <ReportActions>
            {vm.footer.map((entry, i) => {
              const label = fillTokens(messages.actionMessage(entry.code), {
                ...tokens,
                value: entry.value ?? "",
              });
              if (NON_ACTION_CODES.has(entry.code)) {
                return <ReportActionNote key={i}>{label}</ReportActionNote>;
              }
              return (
                <ActionButton
                  key={i}
                  code={entry.code}
                  label={label}
                  target={classifyLink(linkByKey(entry.link), resolveUri)}
                  onIntent={onIntent}
                />
              );
            })}
            {recoveryWatch && onIntent ? (
              <ReportActionButton
                label="Watch for recovery"
                tone="support"
                onClick={() => onIntent(recoveryWatch)}
              />
            ) : null}
          </ReportActions>
        </>
      ) : null}

      {/* Resources the report cites, resolved to dashboard links by the host. */}
      {vm.links.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {vm.links.map((link) => {
            const target = classifyLink(link.url, resolveUri);
            if (target.kind === "external") {
              return (
                <ReportLink key={link.key} href={target.url}>
                  {link.label}
                </ReportLink>
              );
            }
            if (target.kind === "resource" && target.resolved) {
              return (
                <ReportLink key={link.key} href={target.resolved.url}>
                  {target.resolved.label}
                </ReportLink>
              );
            }
            return null;
          })}
        </div>
      ) : null}

      {reportUri ? <ReportMeta>{reportUri}</ReportMeta> : null}
    </ReportSurface>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
