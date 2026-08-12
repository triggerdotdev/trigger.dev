/**
 * The report card: the panel's rendering of a `report` view block.
 *
 * Structure, labels and wording come from `report-layout.ts` (`buildReportLayout`),
 * the same spec the markdown and ANSI renderers consume, so the card, the CLI and
 * the agent's grounding show one report. This file only decides what each layout
 * piece looks like as a component; where the text surfaces use a glyph, the card
 * uses colour and an icon.
 *
 * Pure component: props in, no Remix hooks, no loader data, no router context, so
 * it renders identically in any host. That means the host resolves `trigger://`
 * URIs via `resolveUri`, and in-app footer actions emit an `AgentIntent` instead
 * of navigating. Only entries whose target is an external URL are real links.
 */
import {
  isTriggerUri,
  type AgentIntent,
  type ReportViewModelPayload,
  type TriggerUri,
} from "@internal/dashboard-agent-contracts";
import { type ReactNode } from "react";
import { healthMessages } from "~/presenters/v3/reports/health/health-messages";
import {
  buildReportLayout,
  fmtValue,
  REPORT_LABELS,
  reportFooterStyle,
  type LayoutFinding,
  type LayoutMetricRow,
} from "~/presenters/v3/reports/report-layout";
import { type ReportMessages } from "~/presenters/v3/reports/report-messages";
import { AgentBadge } from "./agent-badges";
import { seriesEndMs as toSeriesEndMs } from "./report-spark";
import {
  FOOTER_WATCH_CODE,
  ReportBody,
  ReportCard,
  ReportFindingLine,
  ReportFooterAction,
  ReportFooterActionLink,
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
  type ReportFooterItem,
} from "./report-sparkline";
import { reportOffersRecoveryWatch } from "./view-actions";

export type ResolvedUri = { label: string; url: string };

/** How often a recovery watch polls, and how long it lives. Aggregate conditions floor at 5m. */
const RECOVERY_WATCH = { checkEveryMinutes: 5, maxHours: 6 } as const;

// --- messages ---------------------------------------------------------------

/**
 * Fallback for a report with no registered catalog (an old transcript, a report
 * that hasn't shipped its messages): show the raw codes rather than crash or
 * invent prose.
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

// --- links ------------------------------------------------------------------

/**
 * What a `vm.links` entry points at: an external doc URL or a `trigger://` URI.
 * They differ because only the host can turn a URI into a route.
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
 * One footer entry, rendered the way its code says (`reportFooterStyle`). An
 * in-app action emits a `navigate` intent, or an `ask` when the report named no
 * target, so the user can still get the "how" from the agent.
 */
function footerEntryNode({
  code,
  label,
  target,
  onIntent,
  pagePath,
}: {
  code: string;
  label: string;
  target: LinkTarget;
  onIntent?: (intent: AgentIntent) => void;
  /** A host-resolved dashboard path for this action (settings pages). */
  pagePath?: string;
}): ReactNode {
  const style = reportFooterStyle(code);

  if (style === "note") return <ReportFooterNote>{label}</ReportFooterNote>;

  // A settings-page action the host resolved wins over everything: the user can
  // self-serve it there (e.g. raising the env concurrency limit).
  if (style === "action" && pagePath) {
    return <ReportFooterActionLink href={pagePath}>{label}</ReportFooterActionLink>;
  }

  // A docs entry is always the docs button, whatever shape its link arrived in:
  // external URL, resolved resource, or nothing (then its canonical docs page).
  if (style === "docs") {
    const href =
      target.kind === "external"
        ? target.url
        : target.kind === "resource" && target.resolved
          ? target.resolved.url
          : DOCS_URL_FALLBACK[code];
    if (href) {
      return (
        <ReportFooterActionLink href={href} docs>
          {label}
        </ReportFooterActionLink>
      );
    }
    return <ReportFooterNote>{label}</ReportFooterNote>;
  }

  if (style === "reference") {
    const href =
      target.kind === "external"
        ? target.url
        : target.kind === "resource" && target.resolved
          ? target.resolved.url
          : REFERENCE_URL_FALLBACK[code];
    if (href) {
      return (
        <ReportFooterLink href={href} external={!href.startsWith("/")}>
          {label}
        </ReportFooterLink>
      );
    }
    return <ReportFooterNote>{label}</ReportFooterNote>;
  }

  // An action whose target is a URL stays a button; the arrow says it leaves.
  const actionHref =
    target.kind === "external"
      ? target.url
      : target.kind === "none"
        ? ACTION_URL_FALLBACK[code]
        : undefined;
  if (actionHref) {
    return <ReportFooterActionLink href={actionHref}>{label}</ReportFooterActionLink>;
  }

  const intent: AgentIntent =
    target.kind === "resource"
      ? { kind: "navigate", target: target.uri }
      : { kind: "ask", prompt: `How do I ${lowerFirst(label)}?` };

  if (!onIntent) return <ReportFooterNote>{label}</ReportFooterNote>;

  return <ReportFooterAction onClick={() => onIntent(intent)}>{label}</ReportFooterAction>;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Canonical docs pages for footer codes whose report entry carries no URL.
 * Without one the entry degrades to prose, which reads as a bug.
 */
const DOCS_URL_FALLBACK: Record<string, string> = {
  concurrency_docs: "https://trigger.dev/docs/queue-concurrency",
  retries_docs: "https://trigger.dev/docs/errors-retrying",
  queues_docs: "https://trigger.dev/docs/queues",
};

/**
 * Canonical destinations for action codes whose report entry carries no URL, so
 * the button opens the page instead of asking the agent how to get there.
 * Unknown codes keep the `ask` fallback.
 */
const ACTION_URL_FALLBACK: Record<string, string> = {
  contact_us_raise_limit: "https://trigger.dev/contact",
};

/** Same idea for cited references: a place to look must stay a link. */
const REFERENCE_URL_FALLBACK: Record<string, string> = {
  check_control_plane: "https://status.trigger.dev",
  check_platform_status: "https://status.trigger.dev",
};

// --- pieces -----------------------------------------------------------------

function MetricRow({
  row,
  windowMinutes,
  seriesEndMs,
}: {
  row: LayoutMetricRow;
  windowMinutes: number;
  seriesEndMs: number | null;
}) {
  // The hero row's annotation is spelled out rather than tucked in with the baseline.
  const annotation = row.note?.kind === "annotation" ? row.note.text : undefined;

  return (
    <ReportMetricRow
      label={row.label}
      value={row.value}
      severity={row.severity}
      subRows={row.subRows.length > 0 ? row.subRows : undefined}
      delta={row.delta}
      note={row.hero && annotation ? undefined : row.note?.text}
      heroNote={row.hero ? annotation : undefined}
      series={row.series}
      windowMinutes={windowMinutes}
      anomalyMinutes={row.anomalyMinutes}
      seriesEndMs={seriesEndMs}
      formatPoint={(value) => fmtValue(value, row.unit)}
    />
  );
}

/**
 * A finding's evidence: its metric grid, then the `why:` block. The verdict itself
 * is the headline or the finding line above.
 */
function FindingBody({
  finding,
  windowMinutes,
  seriesEndMs,
}: {
  finding: LayoutFinding;
  windowMinutes: number;
  seriesEndMs: number | null;
}) {
  return (
    <div className="space-y-2.5">
      <ReportMetricList>
        {finding.metrics.map((row) => (
          <MetricRow
            key={row.id}
            row={row}
            windowMinutes={windowMinutes}
            seriesEndMs={seriesEndMs}
          />
        ))}
      </ReportMetricList>

      <ReportNoteBlock label={REPORT_LABELS.why}>
        {finding.why.map((line, i) => (
          <ReportProse
            key={i}
            text={line}
            entities={finding.attributionKey ? [finding.attributionKey] : undefined}
          />
        ))}
      </ReportNoteBlock>
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
  /**
   * Host-supplied dashboard paths for footer actions that live on a settings page
   * rather than behind a URI, keyed by footer code. Only the host knows the
   * org/project/env slugs.
   */
  pagePaths,
}: {
  vm: ReportViewModelPayload;
  reportUri?: string;
  onIntent?: (intent: AgentIntent) => void;
  resolveUri?: (uri: string) => ResolvedUri | null;
  pagePaths?: Record<string, string>;
}) {
  const layout = buildReportLayout(vm, messagesFor(vm.title));
  const severity = layout.headline.severity;
  const seriesEndMs = toSeriesEndMs(vm.generatedAt);
  const linkByKey = (key: string | undefined) =>
    key === undefined ? undefined : vm.links.find((link) => link.key === key)?.url;

  // Only offered when there is something to recover from, and only for the health
  // report, which is the one with a recovery watch kind.
  const recoveryWatch: AgentIntent | null = reportOffersRecoveryWatch(vm)
    ? {
        kind: "watch",
        spec: {
          kind: "health_recovery",
          report: "health",
          fromSeverity: vm.summary.severity,
          note: `${vm.scope} health back to normal`,
          ...RECOVERY_WATCH,
        },
      }
    : null;

  // Links a footer action already speaks for aren't repeated as reading matter.
  const footerLinkKeys = new Set(layout.footer.map((entry) => entry.link).filter(Boolean));

  const footerItems: ReportFooterItem[] = layout.footer.map((entry) => ({
    code: entry.code,
    node: footerEntryNode({
      code: entry.code,
      label: entry.label,
      target: classifyLink(linkByKey(entry.link), resolveUri),
      onIntent,
      pagePath: pagePaths?.[entry.code],
    }),
  }));

  if (recoveryWatch && onIntent) {
    const watchItem: ReportFooterItem = {
      code: FOOTER_WATCH_CODE,
      // The label is deliberately the same everywhere; only the pre-filled spec is
      // contextual, so a per-object label would break the pattern.
      node: <ReportFooterAction onClick={() => onIntent(recoveryWatch)}>Watch…</ReportFooterAction>,
    };
    // The watch joins the other buttons, before the trailing prose entry.
    const noteIndex = footerItems.findIndex((item) => reportFooterStyle(item.code) === "note");
    if (noteIndex !== -1) {
      footerItems.splice(noteIndex, 0, watchItem);
    } else {
      footerItems.push(watchItem);
    }
  }

  // Resources the report cites, resolved to dashboard links by the host. Cited,
  // not offered, so a text link; our docs still get the docs button.
  for (const link of vm.links) {
    if (footerLinkKeys.has(link.key)) continue;
    const target = classifyLink(link.url, resolveUri);
    if (target.kind === "external") {
      footerItems.push({
        code: link.key,
        node:
          reportFooterStyle(link.key) === "docs" ? (
            <ReportFooterActionLink href={target.url} docs>
              {link.label}
            </ReportFooterActionLink>
          ) : (
            <ReportFooterLink href={target.url} external>
              {link.label}
            </ReportFooterLink>
          ),
      });
    } else if (target.kind === "resource" && target.resolved) {
      footerItems.push({
        code: link.key,
        node: (
          <ReportFooterLink href={target.resolved.url}>{target.resolved.label}</ReportFooterLink>
        ),
      });
    }
  }

  return (
    <ReportCard>
      <ReportHeaderLine name={layout.header.name} meta={layout.header.meta}>
        {layout.trust ? <AgentBadge tone="warning">{layout.trust.badge}</AgentBadge> : null}
      </ReportHeaderLine>

      <ReportBody dimmed={layout.trust !== undefined}>
        <ReportHeadline
          severity={severity}
          tone={layout.headline.tone}
          phrase={layout.headline.phrase}
          continuation={layout.headline.text}
        />

        {layout.trust ? <p className="text-sm text-warning">{layout.trust.note}</p> : null}

        {layout.hero && layout.hero.expanded ? (
          <FindingBody
            finding={layout.hero}
            windowMinutes={vm.windowMinutes}
            seriesEndMs={seriesEndMs}
          />
        ) : null}

        {layout.findings.length > 0 || layout.statements.length > 0 ? (
          <div className="space-y-2.5">
            {layout.findings.map((finding, i) => (
              <div key={`${finding.type}-${i}`} className="space-y-2">
                <ReportFindingLine
                  severity={finding.severity}
                  tone={finding.tone}
                  type={finding.label}
                  bright={finding.severity !== "ok"}
                  text={finding.text}
                />
                {finding.expanded ? (
                  <div className="pl-[1.375rem]">
                    <FindingBody
                      finding={finding}
                      windowMinutes={vm.windowMinutes}
                      seriesEndMs={seriesEndMs}
                    />
                  </div>
                ) : null}
              </div>
            ))}
            {layout.statements.map((statement, i) => (
              <p key={`s${i}`} className="flex items-center gap-1.5 text-sm">
                <ReportSeverityIcon severity={statement.severity} tone={statement.tone} />
                <span className="text-text-dimmed">{statement.text}</span>
              </p>
            ))}
          </div>
        ) : null}

        <ReportNoteBlock label={REPORT_LABELS.read}>
          {layout.reads.map((read, i) => (
            <ReportProse key={i} text={read} />
          ))}
        </ReportNoteBlock>

        <ReportFooterLine items={footerItems} />

        {reportUri ? <ReportProvenance uri={reportUri} /> : null}
      </ReportBody>
    </ReportCard>
  );
}
