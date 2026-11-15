import {
  ClockIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  MinusCircleIcon,
} from "@heroicons/react/20/solid";
import { formatDistanceToNowStrict } from "date-fns";
import { Fragment } from "react";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import type { AttentionRow } from "~/presenters/v3/EnvironmentVariablesAttentionPresenter.server";
import { cn } from "~/utils/cn";
import type { AttentionKind } from "~/v3/environmentVariables/attention";
import { oidcServiceForKey } from "~/v3/environmentVariables/oidcReplaceable";

/** Most pressing first: a missing or empty value breaks runs; OIDC is advice; recent is news. */
export const REASON_ORDER: AttentionKind[] = ["missing", "empty", "oidc", "recent"];

export function sortedReasons(row: AttentionRow): AttentionKind[] {
  return REASON_ORDER.filter((kind) => row.kinds.includes(kind));
}

export const REASON_ICONS: Record<
  AttentionKind,
  { icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  missing: { icon: ExclamationTriangleIcon, className: "text-warning" },
  empty: { icon: MinusCircleIcon, className: "text-warning" },
  oidc: { icon: KeyIcon, className: "text-indigo-500" },
  recent: { icon: ClockIcon, className: "text-text-dimmed" },
};

export const REASON_TITLES: Record<AttentionKind, string> = {
  missing: "Missing here",
  empty: "Empty",
  oidc: "Replace with OIDC",
  recent: "Changed recently",
};

/** The one specific thing to know about a reason, as a short line. */
function ReasonDetail({ row, kind }: { row: AttentionRow; kind: AttentionKind }) {
  switch (kind) {
    case "empty":
      return <>Set to an empty string</>;
    case "missing":
      return (
        <>
          {/* One text node with its space: a lone space node is dropped from the accessible name. */}
          {"Set in "}
          {(row.notSetHere?.setIn ?? []).map((environment, index) => (
            <Fragment key={environment.id}>
              {index > 0 && ", "}
              <EnvironmentLabel environment={environment} disableTooltip truncate={false} />
            </Fragment>
          ))}
        </>
      );
    case "recent": {
      const by =
        row.updatedByUser?.name ??
        (row.lastUpdatedBy?.type === "integration" ? row.lastUpdatedBy.integration : undefined);
      return (
        <>
          Changed {formatDistanceToNowStrict(new Date(row.updatedAt), { addSuffix: true })}
          {by ? <> by {by}</> : null}
        </>
      );
    }
    case "oidc": {
      // The guide label names the service the way people say it ("AWS", not "Amazon Web Services").
      const service = oidcServiceForKey(row.key)?.guideLabel.replace(/ setup guide$/, "");
      if (!service) {
        return <>Could use OIDC</>;
      }
      return `Holds ${/^[AEIOU]/.test(service) ? "an" : "a"} ${service} credential`;
    }
  }
}

/** One reason: its icon and its detail line. */
function ReasonLine({ row, kind }: { row: AttentionRow; kind: AttentionKind }) {
  const { icon: Icon, className: iconClassName } = REASON_ICONS[kind];
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-sm">
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconClassName)} aria-hidden />
      <span className="sr-only">{REASON_TITLES[kind]}: </span>
      <span className={cn("min-w-0", kind === "missing" ? "whitespace-normal" : "truncate")}>
        <ReasonDetail row={row} kind={kind} />
      </span>
    </span>
  );
}

/** Every reason of a row, most pressing first, one per line. */
export function ReasonLines({ row }: { row: AttentionRow }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {sortedReasons(row).map((kind) => (
        <ReasonLine key={kind} row={row} kind={kind} />
      ))}
    </span>
  );
}

/** The Ignored tab: each ignored reason, who ignored it and when. */
export function IgnoredReasonLines({ row }: { row: AttentionRow }) {
  const ignored = REASON_ORDER.flatMap((kind) => row.ignored.filter((i) => i.kind === kind));
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {ignored.map(({ kind, createdAt, createdBy }) => {
        const { icon: Icon } = REASON_ICONS[kind];
        return (
          <span key={kind} className="flex min-w-0 items-start gap-1.5 text-sm">
            <Icon className="mt-0.5 size-4 shrink-0 text-text-dimmed" aria-hidden />
            <span className="min-w-0 truncate">
              {REASON_TITLES[kind]}
              <span className="text-text-dimmed">
                {" "}
                ignored
                {createdBy ? <> by {createdBy.name}</> : null}
                {createdAt ? (
                  <> {formatDistanceToNowStrict(new Date(createdAt), { addSuffix: true })}</>
                ) : null}
              </span>
            </span>
          </span>
        );
      })}
    </span>
  );
}
