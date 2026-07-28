/**
 * The report card — the panel's rendering of a `report` view block.
 *
 * A report is a snapshot of a `ReportViewModel`: numbers plus message *codes*,
 * never prose. Every string on this card is resolved through the report's own
 * message catalog (`report-messages.ts`), which is also what the markdown and
 * ANSI renderers use — so the chat card, the CLI and the agent's own grounding
 * can't drift into three different vocabularies.
 *
 * The layout reads top to bottom as one argument: a quiet header line, one
 * headline that names the state, the metric grid that proves it, "why:" for what
 * owns it, "read:" for what it means, and a single line of actions. The pieces
 * live in `report-sparkline.tsx` and are shared with the demo card.
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
import { Button } from "~/components/primitives/Buttons";
// Imported for its registration side effect as much as its value: each report's
// catalog registers itself under the report's title on import.
import { healthMessages } from "~/presenters/v3/reports/health/health-messages";
import { type ReportMessages } from "~/presenters/v3/reports/report-messages";
import { reportIsTrustworthy } from "./report-block-adapter";
import {
  ReportBody,
  ReportCard,
  ReportFindingLine,
  ReportFooterLine,
  ReportFooterLink,
  ReportFooterNote,
  ReportHeaderLine,
  ReportHeadline,
  ReportMetricList,
  ReportMetricRow,
  ReportNoteBlock,
  ReportProvenance,
  ReportSeverityIcon,
  reportDelta,
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

/**
 * One footer action. Docs live outside the app, so they stay a link; anything
 * in-app is a real action and gets the primary button, emitting a `navigate`
 * intent — or an `ask`, when the report named no target, so the user can still
 * pull the "how" out of the agent.
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
      <ReportFooterLink href={target.url} external>
        {label}
      </ReportFooterLink>
    );
  }

  const intent: AgentIntent =
    target.kind === "resource"
      ? { kind: "navigate", target: target.uri }
      : { kind: "ask", prompt: `How do I ${lowerFirst(label)}?` };

  if (!onIntent) return <ReportFooterNote>{label}</ReportFooterNote>;

  return (
    <Button variant="primary/small" onClick={() => onIntent(intent)}>
      {label}
    </Button>
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
  hero,
}: {
  vm: ReportViewModelPayload;
  metric: ReportMetricPayload;
  messages: ReportMessages;
  anomalyMinutes?: number;
  /** The metric that explains the finding: its annotation is spelled out inline. */
  hero?: boolean;
}) {
  const annotation = metric.annotation
    ? fillTokens(messages.annotationMessage(metric.annotation.code), metricTokens(vm, metric))
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
      label={messages.metricLabel(metric.id)}
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

/**
 * A finding's evidence: its metric grid, then the "why:" block — who owns the
 * problem, and what it isn't. The finding's own verdict is a headline or a
 * finding line above; this is only what backs it up.
 */
function FindingBody({
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
    <div className="space-y-2.5">
      <ReportMetricList>
        {metrics.map((metric, i) => (
          <MetricRow
            key={metric.id}
            vm={vm}
            metric={metric}
            messages={messages}
            anomalyMinutes={i === 0 ? anomalyMinutes : undefined}
            hero={i === 0}
          />
        ))}
      </ReportMetricList>

      <ReportNoteBlock label="why:">
        {finding.attribution ? (
          <>
            {Math.round(finding.attribution.share * 100)}% of {finding.attribution.of} is{" "}
            <span className="font-mono text-text-bright">{finding.attribution.key}</span>
          </>
        ) : null}
        {(finding.exclusions ?? []).map((exclusion, i) => (
          <span key={`x${i}`}>
            {fillTokens(messages.exclusionMessage(exclusion.code), {
              ...tokens,
              ...(exclusion.evidence ?? {}),
            })}
          </span>
        ))}
        {(finding.observations ?? []).map((observation, i) => (
          <span key={`o${i}`}>
            {fillTokens(messages.observationMessage(observation.code), {
              ...tokens,
              ...(observation.evidence ?? {}),
            })}
          </span>
        ))}
      </ReportNoteBlock>
    </div>
  );
}

/** The finding the headline speaks for: the first one at the report's severity. */
function heroIndexOf(vm: ReportViewModelPayload): number {
  const index = vm.findings.findIndex((finding) => finding.severity === vm.summary.severity);
  return index === -1 ? 0 : index;
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

  const heroIndex = heroIndexOf(vm);
  const hero = vm.findings[heroIndex] as ReportFindingPayload | undefined;
  const otherFindings = vm.findings.filter((_, i) => i !== heroIndex);
  const heroStatement = vm.summary.statements.find((s) => s.findingType === hero?.type);

  // The headline speaks for the hero finding. When its statement carries a reason
  // of its own (stale telemetry, no freshness signal) that statement IS the whole
  // sentence — the finding's reason would only repeat it.
  const headlinePhrase = hero
    ? messages.statementMessage(hero.type, hero.severity, heroStatement?.reason)
    : messages.statementMessage(vm.title, severity);
  const headlineContinuation =
    hero && !heroStatement?.reason
      ? fillTokens(
          messages.findingReason(hero.type, hero.reason, { expanded: hero.severity === "ok" }),
          tokens
        ) +
        (hero.anomalyWindow?.touchesEnd ? ` for the last ${hero.anomalyWindow.minutes} min` : "")
      : undefined;

  // A statement with no finding behind it still has to be said.
  const orphanStatements = vm.summary.statements.filter(
    (statement) => !vm.findings.some((finding) => finding.type === statement.findingType)
  );

  const reads = (hero ? [hero, ...otherFindings] : otherFindings)
    .filter((finding) => finding.read !== undefined)
    .map((finding) => fillTokens(messages.readMessage(finding.read!), tokens));

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

  // Links a footer action already speaks for aren't repeated as reading matter.
  const footerLinkKeys = new Set(vm.footer.map((entry) => entry.link).filter(Boolean));

  return (
    <ReportCard>
      <ReportHeaderLine
        name={vm.title}
        meta={`${vm.scope} · ${vm.period}${vm.baselineLabel ? ` · ${vm.baselineLabel}` : ""}`}
      >
        {trustworthy ? null : (
          <Badge variant="small" className="border-warning/40 text-warning">
            stale data
          </Badge>
        )}
      </ReportHeaderLine>

      <ReportBody dimmed={!trustworthy}>
        <ReportHeadline
          severity={severity}
          phrase={headlinePhrase}
          continuation={headlineContinuation}
        />

        {trustworthy ? null : (
          <p className="text-sm text-warning">
            The telemetry behind this report is stale, so the numbers below are informational only.
          </p>
        )}

        {hero ? <FindingBody vm={vm} finding={hero} messages={messages} tokens={tokens} /> : null}

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
                        messages.findingReason(finding.type, finding.reason, {
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
                      <FindingBody vm={vm} finding={finding} messages={messages} tokens={tokens} />
                    </div>
                  ) : null}
                </div>
              );
            })}
            {orphanStatements.map((statement, i) => (
              <p key={`s${i}`} className="flex items-center gap-1.5 text-sm">
                <ReportSeverityIcon severity={statement.severity} />
                <span className="text-text-dimmed">
                  {messages.statementMessage(
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
            <span key={i}>{read}</span>
          ))}
        </ReportNoteBlock>

        <ReportFooterLine>
          {vm.footer.map((entry, i) => {
            const label = fillTokens(messages.actionMessage(entry.code), {
              ...tokens,
              value: entry.value ?? "",
            });
            if (NON_ACTION_CODES.has(entry.code)) {
              return <ReportFooterNote key={i}>{label}</ReportFooterNote>;
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
            <Button variant="primary/small" onClick={() => onIntent(recoveryWatch)}>
              Watch for recovery
            </Button>
          ) : null}
          {/* Resources the report cites, resolved to dashboard links by the host. */}
          {vm.links
            .filter((link) => !footerLinkKeys.has(link.key))
            .map((link) => {
              const target = classifyLink(link.url, resolveUri);
              if (target.kind === "external") {
                return (
                  <ReportFooterLink key={link.key} href={target.url} external>
                    {link.label}
                  </ReportFooterLink>
                );
              }
              if (target.kind === "resource" && target.resolved) {
                return (
                  <ReportFooterLink key={link.key} href={target.resolved.url}>
                    {target.resolved.label}
                  </ReportFooterLink>
                );
              }
              return null;
            })}
        </ReportFooterLine>

        {reportUri ? <ReportProvenance uri={reportUri} /> : null}
      </ReportBody>
    </ReportCard>
  );
}
