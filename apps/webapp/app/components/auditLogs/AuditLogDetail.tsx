import { useLocation } from "@remix-run/react";
import { Fragment, type ReactNode, useState } from "react";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { Button } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { useOrganization } from "~/hooks/useOrganizations";
import { v3DeploymentPath } from "~/utils/pathBuilder";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import type { AuditLogEventView } from "~/presenters/v3/AuditLogPresenter.server";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { AuditLogActor, AuditLogAction, targetLabel } from "./AuditLogParts";
import { AUDIT_LOG_CATEGORY_LABELS } from "./auditLogEvents";
import {
  type AuditLogChangeRow,
  type AuditLogChangeValue,
  auditLogChangeRows,
} from "./auditLogChanges";
import { userAgentLabel } from "./userAgentLabel";
import { cn } from "~/utils/cn";

export function AuditLogDetail({
  event,
  onClose,
}: {
  event: AuditLogEventView;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"details" | "json">("details");

  return (
    <div className="grid h-full grid-rows-[auto_auto_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed py-2 pl-3 pr-2">
        <Header2 className="truncate">{event.actionLabel}</Header2>
        <Button
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
          onClick={onClose}
          aria-label="Close event details"
        />
      </div>
      <div className="px-3">
        <TabContainer>
          <TabButton
            isActive={tab === "details"}
            layoutId="audit-log-detail-tabs"
            onClick={() => setTab("details")}
          >
            Details
          </TabButton>
          <TabButton
            isActive={tab === "json"}
            layoutId="audit-log-detail-tabs"
            onClick={() => setTab("json")}
          >
            Raw JSON
          </TabButton>
        </TabContainer>
      </div>
      <div className="overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        {tab === "details" ? (
          <AuditLogProperties event={event} />
        ) : (
          <CodeBlock
            code={JSON.stringify(event.raw, null, 2)}
            language="json"
            showLineNumbers={false}
            showOpenInModal={false}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Every event involving a key or token ending in these 4 characters, made with it or changing it,
 * in the same time range: the actor menu's "Any key ending" filter. Every other filter is dropped,
 * or the link would show fewer than all of them.
 */
function KeyEndingLink({ last4 }: { last4: string }) {
  const location = useLocation();
  const search = keyEndingSearch(location.search, last4);
  return (
    <TextLink to={`${location.pathname}?${search.toString()}`} className="text-xs">
      All events for keys ending {last4}
    </TextLink>
  );
}

/** The page's search for every event of keys ending `last4`: its time range, and nothing else. */
export function keyEndingSearch(currentSearch: string, last4: string): URLSearchParams {
  const current = new URLSearchParams(currentSearch);
  const search = new URLSearchParams();
  for (const name of ["period", "from", "to"]) {
    const value = current.get(name);
    if (value !== null) search.set(name, value);
  }
  search.set("key", last4);
  return search;
}

/** The deployment a build's request was for, linked to its page. */
function DeploymentLink({
  deployment,
}: {
  deployment: NonNullable<AuditLogEventView["deployment"]>;
}) {
  const organization = useOrganization();
  return (
    <TextLink
      to={v3DeploymentPath(
        organization,
        { slug: deployment.projectSlug },
        { slug: deployment.environmentSlug },
        { shortCode: deployment.shortCode },
        0
      )}
    >
      {deployment.version}
    </TextLink>
  );
}

/** Three groups, as in the mockup: who and how, what, and the ids. */
function AuditLogProperties({ event }: { event: AuditLogEventView }) {
  const { reason, endsAt, changes } = splitReason(event);
  const noIp = event.ip ? null : noIpReason(event);
  const rows = auditLogChangeRows(event, changes);

  return (
    <div className="flex flex-col">
      <Fields className="border-b border-grid-dimmed pt-1">
        <Field label="Who">
          <AuditLogActor actor={event.actor} />
          {event.actor.kind === "user" && event.actor.email ? (
            <div className="text-text-dimmed">{event.actor.email}</div>
          ) : null}
        </Field>
        <Field label="Via">
          <div>{event.client}</div>
          {event.credential ? <div className="text-text-dimmed">{event.credential}</div> : null}
          {event.credentialLast4 ? <KeyEndingLink last4={event.credentialLast4} /> : null}
        </Field>
        {event.ip || noIp ? (
          <Field label="From">
            {event.ip ? (
              <>
                <div className="font-mono">{event.ip}</div>
                {event.location ? (
                  <div className="text-text-dimmed">{locationLabel(event.location)}</div>
                ) : null}
              </>
            ) : (
              <span className="text-text-dimmed">{noIp}</span>
            )}
          </Field>
        ) : null}
        {event.userAgent ? (
          <Field label="Client">
            <span title={event.userAgent} className="break-words">
              {userAgentLabel(event.userAgent)}
            </span>
          </Field>
        ) : null}
        <Field label="When">
          <DateTime date={event.occurredAt} timeZone="UTC" hour12={false} showTimezone />
        </Field>
      </Fields>

      <Fields className="border-b border-grid-dimmed">
        <Field label="Category">
          <AuditLogAction
            category={event.category}
            label={AUDIT_LOG_CATEGORY_LABELS[event.category]}
          />
        </Field>
        <Field label="Target" className="font-mono">
          {targetLabel(event)}
        </Field>
        {event.project ? (
          <Field label="Project">
            <span className="flex items-center gap-2">
              {event.project.name}
              {event.environment ? (
                <EnvironmentLabel environment={event.environment} disableTooltip />
              ) : null}
            </span>
          </Field>
        ) : null}
        {rows.length > 0 ? (
          <Field label={rows.length > 1 ? "Changes" : "Change"}>
            <AuditLogChanges rows={rows} />
          </Field>
        ) : null}
        {reason ? <Field label="Reason">{reason}</Field> : null}
        {endsAt ? (
          <Field label="Ends">
            <DateTime date={endsAt} timeZone="UTC" hour12={false} showTimezone />
          </Field>
        ) : null}
        {event.deployment ? (
          <Field label="Deployment">
            <DeploymentLink deployment={event.deployment} />
          </Field>
        ) : null}
      </Fields>

      <Fields>
        <Field label="Event ID">
          <TruncatedCopyableValue value={event.id} className="font-mono" />
        </Field>
        {event.requestId ? (
          <Field label="Request ID">
            <CopyableText value={event.requestId} className="font-mono" />
          </Field>
        ) : null}
      </Fields>

      {event.category === "envvars" ? (
        <Paragraph variant="small" className="border-t border-grid-dimmed pt-3 text-text-dimmed">
          Environment variable values are never stored.
        </Paragraph>
      ) : null}
    </div>
  );
}

/** Labels on the left, values on the right, as in the mockup. */
function Fields({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 py-3 text-sm",
        className
      )}
    >
      {children}
    </dl>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <>
      <dt className="text-text-dimmed">{label}</dt>
      <dd className={cn("min-w-0 text-text-bright", className)}>{children}</dd>
    </>
  );
}

/**
 * A support session's reason and end get their own rows; every other change stays in the diff.
 */
function splitReason(event: AuditLogEventView) {
  if (event.category !== "support" || !event.changes) {
    return { reason: null, endsAt: null, changes: event.changes };
  }
  const { reason, expiresAt, ...rest } = event.changes;
  const endsAt = typeof expiresAt === "string" ? new Date(expiresAt) : null;
  return {
    reason: typeof reason === "string" ? reason : null,
    endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null,
    changes: Object.keys(rest).length > 0 ? rest : null,
  };
}

/** `Germany · AS16509 Amazon`: the country by name, then the network. */
function locationLabel(location: NonNullable<AuditLogEventView["location"]>) {
  const country = location.countryCode ? countryName(location.countryCode) : null;
  const network =
    location.asn !== null
      ? [`AS${location.asn}`, location.asName].filter(Boolean).join(" ")
      : location.asName;
  return [country, network].filter(Boolean).join(" · ");
}

function countryName(code: string) {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Why an event made by Trigger.dev, or from inside a run, shows no IP. */
function noIpReason(event: AuditLogEventView): string | null {
  switch (event.actor.kind) {
    case "run":
      return "Made from inside a task run";
    case "infrastructure":
    case "system":
      return "Made by Trigger.dev infrastructure";
    case "support":
      return "Made by Trigger.dev support";
    case "user":
      return event.actor.bySupport ? "Made by Trigger.dev support" : null;
    default:
      return null;
  }
}

/** One field per row: its name, then its value, or the before struck through and the after. */
function AuditLogChanges({ rows }: { rows: AuditLogChangeRow[] }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      {rows.map((row) => (
        <Fragment key={row.label}>
          <div className="text-text-dimmed">{row.label}</div>
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {row.kind === "value" ? (
              row.tone ? (
                <ChangePill tone={row.tone}>{changeText(row.value)}</ChangePill>
              ) : (
                <ChangeValue value={row.value} />
              )
            ) : row.kind === "changed" ? (
              <>
                <span className="text-text-dimmed line-through">
                  <ChangeValue value={row.before} />
                </span>
                <span className="text-text-dimmed">→</span>
                <ChangeValue value={row.after} />
              </>
            ) : (
              <>
                {row.added.map((item) => (
                  <ChangePill key={`+${item}`} tone="added">
                    {item}
                  </ChangePill>
                ))}
                {row.removed.map((item) => (
                  <ChangePill key={`-${item}`} tone="removed">
                    {item}
                  </ChangePill>
                ))}
              </>
            )}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function ChangeValue({ value }: { value: AuditLogChangeValue }) {
  if (value.kind === "date") return <DateTime date={value.date} hour12={false} />;
  if (value.kind === "list") {
    return (
      <>
        {value.items.map((item) => (
          <ChangePill key={item}>{item}</ChangePill>
        ))}
      </>
    );
  }
  return <span className="break-words">{value.text}</span>;
}

function changeText(value: AuditLogChangeValue) {
  return value.kind === "text"
    ? value.text
    : value.kind === "list"
      ? value.items.join(", ")
      : value.date;
}

/** A list item or a whole value: green with + when added, red with − when removed. */
function ChangePill({ tone, children }: { tone?: "added" | "removed"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 font-mono text-xs",
        tone === "added"
          ? "bg-success/10 text-success"
          : tone === "removed"
            ? "bg-error/10 text-error"
            : "bg-background-bright text-text-bright"
      )}
    >
      {tone === "added" ? "+ " : tone === "removed" ? "− " : ""}
      {children}
    </span>
  );
}
