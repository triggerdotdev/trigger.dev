import type { AuditLogEventSummary } from "@trigger.dev/plugins";
import { type ReactNode, useEffect } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { DateTime } from "~/components/primitives/DateTime";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { timeFilters } from "~/components/runs/v3/SharedFilters";
import type { loader as summaryLoader } from "~/routes/resources.orgs.$organizationSlug.audit-log.summary";
import { AUDIT_LOG_DEFAULT_PERIOD } from "./auditLogEvents";
import { auditLogSummaryPath, auditLogSummaryRangeSearch } from "./auditLogSummarySearch";
import type { AuditLogKeyStatus } from "~/presenters/v3/auditLogKeyStatus.server";

/**
 * Loads the summary for the page's filters once the page has rendered, so it never holds up the
 * list. Mount it keyed on `search`: new filters then start a new fetcher, and an answer is shown only
 * for the filters it was asked for. Shows nothing when the summary is empty or can't be loaded.
 */
export function AuditLogCredentialSummaryLoader({
  organizationSlug,
  search,
  range,
}: {
  organizationSlug: string;
  search: string;
  /** The range the list was read for: the summary reads the same one. */
  range: { from: number; to: number };
}) {
  const fetcher = useTypedFetcher<typeof summaryLoader>();
  const rangeSearch = auditLogSummaryRangeSearch(search, range);
  const path = auditLogSummaryPath(organizationSlug, rangeSearch);

  useEffect(() => {
    fetcher.load(path);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps -- load once per path; the fetcher changes identity every render

  const data = fetcher.data;
  if (data && data.search === rangeSearch) {
    if (data.summary) {
      return (
        <AuditLogCredentialSummary
          summary={data.summary}
          search={search}
          keyStatus={data.keyStatus}
        />
      );
    }
    // No audited events, but the key's own rows may still say it was used, or how it ended: a key
    // used only to trigger runs leaves no audit events.
    return data.keyStatus ? (
      <KeyStatusOnly search={search} keyStatus={data.keyStatus} noEvents={data.noEvents} />
    ) : null;
  }
  return (
    <SummaryRow>
      <span className="flex items-center gap-1.5">
        <Spinner className="size-3" />
        Summarizing this credential's activity…
      </span>
    </SummaryRow>
  );
}

function SummaryRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-grid-bright px-3 py-2">
      <Paragraph variant="small" className="flex flex-wrap items-center gap-x-1.5 text-text-dimmed">
        {children}
      </Paragraph>
    </div>
  );
}

/**
 * The time range a summary covers, worded as the page's time filter shows it: `Last 7 days`, the
 * range's start and end, or `Occurred after` / `Occurred before` a date. `text` comes first, then
 * `value`. A summary covers only this range, so "first seen" isn't read as first ever used.
 */
export function auditLogSummaryRange(search: string): { text: string | null; value: ReactNode } {
  const params = new URLSearchParams(search);
  const time = timeFilters({
    period: params.get("period") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    defaultPeriod: AUDIT_LOG_DEFAULT_PERIOD,
    labelName: "Occurred",
  });
  switch (time.rangeType) {
    case "period":
      return { text: `Last ${String(time.valueLabel)}`, value: null };
    case "range":
      return { text: null, value: time.valueLabel };
    case "from":
    case "to":
      return { text: time.label, value: time.valueLabel };
  }
}

/**
 * When and from where the filtered credential was used, over the events listed below:
 * `Last 7 days: First seen Nov 4 · Last seen Nov 19, 14:02 · 37 events · 3 IPs (United Kingdom,
 * Germany)`. Times are the viewer's, as the table shows them.
 */
function AuditLogCredentialSummary({
  summary,
  search,
  keyStatus,
}: {
  summary: AuditLogEventSummary;
  search: string;
  /** What the key's own rows say: its last use, and how it ended. */
  keyStatus: AuditLogKeyStatus | null;
}) {
  const range = auditLogSummaryRange(search);
  if (!summary.firstSeenAt || !summary.lastSeenAt) return null;
  const countries = summary.countryCodes.map(countryName).sort();
  const moreCountries = summary.countryCount - countries.length;
  // Large summaries are estimated, within about 0.1%.
  const about = summary.approximate ? "≈" : "";
  const ips = `${about}${plural(summary.ipCount, "IP")}`;

  return (
    <div className="border-b border-grid-bright px-3 py-2">
      <Paragraph variant="small" className="flex flex-wrap items-center gap-x-1.5 text-text-dimmed">
        <span className="whitespace-nowrap text-text-bright">
          {range.text}
          {range.text && range.value ? " " : null}
          {range.value}:
        </span>
        <span className="whitespace-nowrap">
          First seen{" "}
          <span className="text-text-bright">
            <DateTime date={summary.firstSeenAt} hour12={false} includeSeconds={false} />
          </span>
        </span>
        <Separator />
        <span className="whitespace-nowrap">
          Last seen{" "}
          <span className="text-text-bright">
            <DateTime date={summary.lastSeenAt} hour12={false} includeSeconds={false} />
          </span>
        </span>
        <Separator />
        <span>
          {about}
          {plural(summary.eventCount, "event")}
        </span>
        <Separator />
        {summary.recentIps.length > 0 ? (
          <SimpleTooltip
            button={
              <span className="whitespace-nowrap underline decoration-dotted underline-offset-2">
                {ips}
              </span>
            }
            content={<RecentIps recentIps={summary.recentIps} />}
            disableHoverableContent
          />
        ) : (
          <span>{summary.ipCount > 0 ? ips : "No customer IPs"}</span>
        )}
        {countries.length > 0 ? (
          <>
            <Separator />
            <SimpleTooltip
              button={
                <span className="whitespace-nowrap underline decoration-dotted underline-offset-2">
                  {about}
                  {summary.countryCount.toLocaleString("en-US")}{" "}
                  {summary.countryCount === 1 ? "country" : "countries"}
                </span>
              }
              content={<Countries countries={countries} more={moreCountries} />}
              disableHoverableContent
            />
          </>
        ) : null}
        {keyStatus ? <KeyStatusParts keyStatus={keyStatus} /> : null}
      </Paragraph>
    </div>
  );
}

/** `Last used Nov 20, 09:44 · Revoked Nov 19, 14:02`. */
function KeyStatusParts({
  keyStatus,
  leading = true,
}: {
  keyStatus: AuditLogKeyStatus;
  /** Whether something comes before, so the first part needs a separator too. */
  leading?: boolean;
}) {
  return (
    <>
      {keyStatus.lastUsedAt ? (
        <>
          {leading ? <Separator /> : null}
          <span className="whitespace-nowrap">
            Last used{" "}
            <span className="text-text-bright">
              <DateTime date={keyStatus.lastUsedAt} hour12={false} includeSeconds={false} />
            </span>
          </span>
        </>
      ) : null}
      {keyStatus.end ? (
        <>
          {leading || keyStatus.lastUsedAt ? <Separator /> : null}
          <KeyEnd end={keyStatus.end} />
        </>
      ) : null}
    </>
  );
}

/**
 * For a key with no audited events in the range: what its own rows say, so a key used only to
 * trigger runs still shows when it was last used and how it ended.
 */
function KeyStatusOnly({
  search,
  keyStatus,
  noEvents,
}: {
  search: string;
  keyStatus: AuditLogKeyStatus;
  /** The plugin answered that nothing matches. False when the summary failed: then say nothing. */
  noEvents: boolean;
}) {
  const range = auditLogSummaryRange(search);
  return (
    <SummaryRow>
      {noEvents ? (
        <span className="whitespace-nowrap text-text-bright">
          {range.text}
          {range.text && range.value ? " " : null}
          {range.value}:
        </span>
      ) : null}
      {noEvents ? (
        <SimpleTooltip
          button={
            <span className="whitespace-nowrap underline decoration-dotted underline-offset-2">
              No audited events
            </span>
          }
          content={AUDITED_ONLY}
          disableHoverableContent
        />
      ) : null}
      <KeyStatusParts keyStatus={keyStatus} leading={noEvents} />
    </SummaryRow>
  );
}

/** Says which events "seen" counts: a key's other use, such as triggering runs, isn't audited. */
const AUDITED_ONLY =
  "Counts audited actions only: changes to keys, environment variables and members, environment variable reads and support sessions. Triggering runs and other API calls aren't recorded.";

/**
 * `Revoked Nov 19, 14:02, worked until Nov 20, 14:02`: when the key stopped working. A root key
 * rotated without a grace period says only "Revoked": when isn't kept.
 */
function KeyEnd({ end }: { end: NonNullable<AuditLogKeyStatus["end"]> }) {
  const at = (date: Date) => <DateTime date={date} hour12={false} includeSeconds={false} />;
  return (
    <span className="whitespace-nowrap">
      {end.reason === "revoked" ? "Revoked" : "Expired"}
      {end.at ? (
        <>
          {" "}
          <span className="text-text-bright">{at(end.at)}</span>
        </>
      ) : null}
      {end.at && end.workedUntil && end.workedUntil > end.at ? (
        <>
          , {end.workedUntil > new Date() ? "works" : "worked"} until{" "}
          <span className="text-text-bright">{at(end.workedUntil)}</span>
        </>
      ) : null}
    </span>
  );
}

function Countries({ countries, more }: { countries: string[]; more: number }) {
  return (
    <div className="flex flex-col gap-1">
      <Paragraph variant="extra-small" className="text-text-dimmed">
        Countries
      </Paragraph>
      {countries.map((country) => (
        <span key={country} className="text-xs text-text-bright">
          {country}
        </span>
      ))}
      {more > 0 ? <span className="text-xs text-text-dimmed">and {more} more</span> : null}
    </div>
  );
}

function RecentIps({ recentIps }: { recentIps: AuditLogEventSummary["recentIps"] }) {
  return (
    <div className="flex flex-col gap-1">
      <Paragraph variant="extra-small" className="text-text-dimmed">
        Most recent IPs
      </Paragraph>
      {recentIps.map((recent) => (
        <div key={recent.ip} className="flex flex-col">
          <span className="font-mono text-xs text-text-bright">{recent.ip}</span>
          <span className="text-xs text-text-dimmed">
            {recent.location ? `${locationLabel(recent.location)} · ` : ""}
            Last seen <DateTime date={recent.lastSeenAt} hour12={false} includeSeconds={false} />
          </span>
        </div>
      ))}
    </div>
  );
}

function Separator() {
  return <span aria-hidden>·</span>;
}

function plural(count: number, noun: string) {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

/** `Germany · AS16509 Amazon`: the country by name, then the network. */
function locationLabel(
  location: NonNullable<AuditLogEventSummary["recentIps"][number]["location"]>
) {
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
