import { CodeBlock } from "~/components/code/CodeBlock";
import { Badge } from "~/components/primitives/Badge";
import { CopyableText } from "~/components/primitives/CopyableText";
import { RelativeDateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { TextLink } from "~/components/primitives/TextLink";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import { AlertStatusBadge } from "./AlertStatusBadge";
import { formatAlertTick } from "./formatAlertTick";

function statusLabel(status: AlertDetail["status"]): string {
  switch (status.status) {
    case "needs_attention":
      return "Needs attention";
    case "active":
      return "Active";
    case "inactive":
      return status.reason === "completed"
        ? "Completed"
        : status.reason === "expired"
          ? "Expired"
          : "Stopped";
  }
}

function CurrentPropertyValue({
  alert,
  objectLinkPath,
}: {
  alert: AlertDetail;
  objectLinkPath?: string;
}) {
  if (alert.occurrenceSummary) {
    return (
      <span>
        {alert.occurrenceSummary.countSinceRaise} occurrence
        {alert.occurrenceSummary.countSinceRaise === 1 ? "" : "s"} &middot; last{" "}
        <RelativeDateTime date={alert.occurrenceSummary.lastOccurrenceAt} capitalize={false} />
      </span>
    );
  }

  const facts =
    alert.currentReading.status === "available" && alert.currentReading.result.kind === "stateful"
      ? alert.currentReading.result.facts
      : undefined;
  const offenders = Array.isArray(facts?.offenders)
    ? (facts.offenders as Array<{ key: string; value: number }>)
    : [];
  const reading = alert.reading;
  const threshold =
    reading && (reading.kind ?? "value") === "value"
      ? (reading as { threshold?: number }).threshold
      : undefined;
  const over = (value: number) =>
    threshold !== undefined && (alert.operator === "<" ? value < threshold : value > threshold);
  const format = (value: number) => formatAlertTick(value, alert.unitSuffix);

  const rows: Array<{ key: string; label: React.ReactNode; value: number }> =
    offenders.length > 0
      ? offenders.map((o) => ({ key: o.key, label: o.key, value: o.value }))
      : reading &&
          reading.kind !== "lowVolume" &&
          reading.kind !== "noData" &&
          reading.kind !== "state"
        ? [
            {
              key: "reading",
              label:
                objectLinkPath && alert.objectLink && alert.objectLink.kind !== "fingerprint" ? (
                  <TextLink to={objectLinkPath}>{alert.objectLink.name}</TextLink>
                ) : null,
              value: reading.value,
            },
          ]
        : [];

  if (reading?.kind === "lowVolume") {
    return (
      <span>
        Low volume &mdash; {reading.total} run{reading.total === 1 ? "" : "s"}
        {reading.windowSec ? ` in the last ${formatWindow(reading.windowSec)}` : ""}
      </span>
    );
  }

  if (reading?.kind === "noData") {
    return (
      <span>
        No recent data{reading.windowSec ? ` (last ${formatWindow(reading.windowSec)})` : ""}
        {reading.lastRaised && (
          <>
            {" "}
            &middot; last raised {reading.lastRaised.value},{" "}
            <RelativeDateTime date={reading.lastRaised.at} capitalize={false} />
          </>
        )}
      </span>
    );
  }

  if (reading?.kind === "state") {
    return (
      <span>
        {reading.state === "met"
          ? "Condition met"
          : reading.state === "not_met"
            ? "Condition not met"
            : "Condition unknown"}{" "}
        &middot; <RelativeDateTime date={reading.observedAt} capitalize={false} />
      </span>
    );
  }

  if (rows.length === 0) return <span>No current reading.</span>;

  return (
    <div className="flex flex-col gap-1">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center justify-between text-sm">
          <span>{row.label}</span>
          <span
            className={
              over(row.value) ? "tabular-nums text-error" : "tabular-nums text-text-bright"
            }
          >
            {format(row.value)}
            {threshold !== undefined && (
              <span className="text-text-faint"> / {format(threshold)}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatWindow(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

export function AlertDetailSidebar({
  alert,
  environmentTitle,
  objectLinkPath,
  actions,
  statusAction,
  footer,
}: {
  alert: AlertDetail;
  environmentTitle: string;
  objectLinkPath?: string;
  actions?: React.ReactNode;
  statusAction?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed px-3 py-2">
        <Header2 className="truncate">Details</Header2>
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
      <div className="min-h-0 overflow-y-auto px-3 py-3">
        <Property.Table>
          <Property.Item className="gap-1">
            <Property.Label>Alert status</Property.Label>
            <Property.Value>
              <div className="flex items-center justify-between gap-1.5">
                <AlertStatusBadge
                  status={alert.status.status}
                  label={statusLabel(alert.status)}
                  prominence="bright"
                />
                {statusAction}
              </div>
            </Property.Value>
          </Property.Item>

          <Property.Item className="gap-1">
            <Property.Label>Condition</Property.Label>
            <Property.Value>
              <CodeBlock
                code={alert.conditionSummary}
                showCopyButton={false}
                showLineNumbers={false}
                showOpenInModal={false}
                language="typescript"
                wrap
              />
            </Property.Value>
          </Property.Item>

          <Property.Item>
            <Property.Label>Scope</Property.Label>
            <Property.Value>
              <span className="mr-1 text-text-dimmed">{environmentTitle} ·</span>
              {objectLinkPath && alert.objectLink ? (
                <TextLink to={objectLinkPath}>{alert.objectLink.name}</TextLink>
              ) : (
                <span>{alert.scopeSummary}</span>
              )}
            </Property.Value>
          </Property.Item>

          {alert.compiledQuery && (
            <Property.Item className="gap-1">
              <Property.Label>Query</Property.Label>
              <Property.Value>
                <CodeBlock
                  className="[&_pre]:whitespace-pre-wrap [&_pre]:break-words"
                  code={alert.compiledQuery}
                  showOpenInModal={false}
                  showLineNumbers={false}
                  language="sql"
                  wrap
                />
              </Property.Value>
            </Property.Item>
          )}

          <Property.Item>
            <Property.Label>ID</Property.Label>
            <Property.Value>
              <CopyableText value={alert.id} />
            </Property.Value>
          </Property.Item>

          <Property.Item className="gap-1">
            <Property.Label>Current</Property.Label>
            <Property.Value>
              <CurrentPropertyValue alert={alert} objectLinkPath={objectLinkPath} />
            </Property.Value>
          </Property.Item>

          <Property.Item>
            <Property.Label>
              {alert.kind === "occurrence" ? "Occurrences" : "Raised"}
            </Property.Label>
            <Property.Value>
              <span className="tabular-nums">{alert.occurrenceCount.toLocaleString("en")}</span>
            </Property.Value>
          </Property.Item>

          {alert.firstEventAt && alert.lastEventAt && (
            <>
              <Property.Item>
                <Property.Label>First event</Property.Label>
                <Property.Value>
                  <RelativeDateTime date={alert.firstEventAt} />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Last event</Property.Label>
                <Property.Value>
                  <RelativeDateTime date={alert.lastEventAt} />
                </Property.Value>
              </Property.Item>
            </>
          )}

          <Property.Item>
            <Property.Label>Behavior</Property.Label>
            <Property.Value>{alert.behaviorLabel}</Property.Value>
          </Property.Item>

          <Property.Item className="gap-1">
            <Property.Label>Notify</Property.Label>
            <Property.Value>
              <div className="flex flex-wrap gap-1.5">
                {alert.notifiers.length === 0 ? (
                  <Paragraph variant="extra-small" className="text-text-dimmed">
                    No notifiers
                  </Paragraph>
                ) : (
                  alert.notifiers.map((notifier) => {
                    const issue = alert.channelIssues.find(
                      (i) => `channel:${i.channelId}` === notifier.key
                    );
                    if (!issue) {
                      return (
                        <Badge key={notifier.key} variant="small">
                          {notifier.label}
                        </Badge>
                      );
                    }
                    return (
                      <SimpleTooltip
                        key={notifier.key}
                        button={
                          <span className="inline-flex items-center rounded bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning contrast-chip">
                            {issue.reason === "deleted"
                              ? "Deleted channel"
                              : issue.reason === "disabled"
                                ? "Disabled channel"
                                : notifier.label}
                          </span>
                        }
                        content="Edit channels to fix this notification channel."
                        side="top"
                        disableHoverableContent
                      />
                    );
                  })
                )}
              </div>
            </Property.Value>
          </Property.Item>
        </Property.Table>
        {footer}
      </div>
    </div>
  );
}
