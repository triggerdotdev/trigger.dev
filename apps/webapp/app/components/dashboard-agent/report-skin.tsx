/**
 * report-skin.tsx — the "terminal" skin a report wears when it renders in chat.
 *
 * WHAT THIS IS
 * A set of presentational primitives, nothing else. They own the *look* of a
 * report card (monospace body, fixed label column, left-aligned sparklines,
 * colour carried by values rather than prose, real buttons in the footer) and
 * know nothing about reports: no view model, no message catalog, no severity
 * interpretation. `ReportView` (the shipped card) and `DemoReportCard` (the
 * design mockup) both dress themselves here, which is what keeps a design
 * review of one valid for the other.
 *
 * WHY IT IS SEPARATE
 * This is the intended report surface for MCP-UI: a host that receives a report
 * over MCP renders the same skin, so a report looks the same in our panel and in
 * someone else's client.
 *
 * CONTRACT
 * - Pure presentation. Props in, markup out. No Remix hooks, no loader data, no
 *   router context, no fetching — asserted by `ReportView.test.ts`.
 * - No vocabulary. Every string is passed in, already resolved by the caller's
 *   message catalog. The skin never invents or interprets prose.
 * - Severity is an input (`"ok" | "warn" | "crit"`), never a decision. The skin
 *   maps it to an icon and a value colour; deciding what is degraded is the
 *   report's job.
 * - Layout is a two-column grid: a fixed-width label column and a left-aligned
 *   content column. Anything that must line up across rows (sparklines, values)
 *   goes in the content column and is never floated or right-aligned.
 * - Colour lives on values, deltas, entities and icons. Body text stays in the
 *   default text colours so a card never reads as a wall of red.
 * - One dependency beyond `cn`: `~/components/primitives/Buttons`, for footer
 *   actions. Those render the design system's real buttons, so a host embedding
 *   the skin needs the app's provider shell (the webapp mounts it globally in
 *   `entry.client`/`entry.server`). Everything else here is plain markup.
 */
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/20/solid";
import { type FunctionComponent, type ReactNode } from "react";
import { Button, LinkButton, type ButtonVariant } from "~/components/primitives/Buttons";
import { type RenderIcon } from "~/components/primitives/Icon";
import { cn } from "~/utils/cn";

/** The three severities every report speaks. Structurally equal to the contract's own. */
export type ReportSkinSeverity = "ok" | "warn" | "crit";

/**
 * How a single value reads. `good`/`warn`/`bad` carry meaning (a healthy entity,
 * an elevated number, a breached one); `dimmed`/`faint` are quiet supporting
 * text; `default` is plain body colour.
 */
export type ReportTone = "default" | "dimmed" | "faint" | "good" | "warn" | "bad";

/** What a footer action *does* — which decides which library button it gets. */
export type ReportActionTone = "navigate" | "docs" | "danger" | "support";

const TONE_TEXT: Record<ReportTone, string> = {
  default: "text-text-bright",
  dimmed: "text-text-dimmed",
  faint: "text-text-faint",
  good: "text-success",
  warn: "text-warning",
  bad: "text-error",
};

/** Severity as a value colour. Only ever applied to values, deltas and icons. */
export const REPORT_SEVERITY_TONE: Record<ReportSkinSeverity, ReportTone> = {
  ok: "good",
  warn: "warn",
  crit: "bad",
};

/**
 * Footer intent -> design system variant. Navigation is the primary (violet)
 * action, docs get the docs treatment, destructive actions the danger one, and
 * everything else (ask the agent, contact support) the secondary.
 */
export const REPORT_ACTION_VARIANT: Record<ReportActionTone, ButtonVariant> = {
  navigate: "primary/small",
  docs: "docs/small",
  danger: "danger/small",
  support: "secondary/small",
};

const SEVERITY_ICON: Record<ReportSkinSeverity, FunctionComponent<{ className?: string }>> = {
  ok: CheckCircleIcon,
  warn: ExclamationTriangleIcon,
  crit: ExclamationCircleIcon,
};

export function reportToneClass(tone: ReportTone): string {
  return TONE_TEXT[tone];
}

// --- surface ----------------------------------------------------------------

/**
 * The terminal panel: a near-black rounded card, monospace at the dashboard's
 * 14px body size, with the generous line spacing the reference asks for.
 *
 * `dimmed` is the untrustworthy/stale state — the numbers stay legible but the
 * whole surface visibly steps back so it can't be read as a live verdict.
 */
export function ReportSurface({
  children,
  dimmed,
  className,
}: {
  children: ReactNode;
  dimmed?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-grid-bright bg-background-deep p-3.5 font-mono text-sm leading-relaxed",
        dimmed && "opacity-70",
        className
      )}
    >
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

/**
 * The dimmed "command" line the card opens with, e.g. `/report health check`.
 * It states what was run, so the card reads as the answer to something.
 */
export function ReportCommandLine({ children }: { children: ReactNode }) {
  return <div className="truncate text-text-faint">{children}</div>;
}

/** The bright identity line, e.g. `Health · prod · last 1h`. */
export function ReportHeadline({ children }: { children: ReactNode }) {
  return <div className="text-text-bright">{children}</div>;
}

/** A hairline between sections. Minimal chrome: one rule, no boxes. */
export function ReportRule() {
  return <div className="h-px bg-grid-bright" role="presentation" />;
}

/** A vertically spaced group of lines. */
export function ReportBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("space-y-1.5", className)}>{children}</div>;
}

/** Provenance and other whisper-quiet metadata (a `trigger://` URI, a timestamp). */
export function ReportMeta({ children }: { children: ReactNode }) {
  return <div className="break-all text-xs text-text-faint">{children}</div>;
}

// --- lines ------------------------------------------------------------------

/** The severity glyph, from the icon set — never a raw `⚠` in the text. */
export function ReportSeverityIcon({
  severity,
  className,
}: {
  severity: ReportSkinSeverity;
  className?: string;
}) {
  const Icon = SEVERITY_ICON[severity];
  return (
    <Icon
      className={cn("size-4 shrink-0", TONE_TEXT[REPORT_SEVERITY_TONE[severity]], className)}
      aria-hidden
    />
  );
}

/**
 * A headline statement: severity icon, then plain body text. The icon carries
 * the severity so the sentence itself doesn't have to be coloured.
 */
export function ReportStatement({
  severity,
  children,
  tone = "default",
}: {
  severity: ReportSkinSeverity;
  children: ReactNode;
  tone?: ReportTone;
}) {
  return (
    <div className="flex items-start gap-2">
      <ReportSeverityIcon severity={severity} className="mt-0.5" />
      <span className={cn("min-w-0", TONE_TEXT[tone])}>{children}</span>
    </div>
  );
}

/** A line of supporting body text. Defaults to quiet, never to a severity colour. */
export function ReportText({
  children,
  tone = "dimmed",
  className,
}: {
  children: ReactNode;
  tone?: ReportTone;
  className?: string;
}) {
  return <p className={cn("min-w-0", TONE_TEXT[tone], className)}>{children}</p>;
}

/**
 * The one line that *is* allowed to be coloured prose: a notice about the report
 * itself (stale telemetry, partial data). It is a caveat on the whole card, not
 * a finding, so it wears its severity openly.
 */
export function ReportNotice({
  severity,
  children,
}: {
  severity: ReportSkinSeverity;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <ReportSeverityIcon severity={severity} className="mt-0.5" />
      <p className={cn("min-w-0", TONE_TEXT[REPORT_SEVERITY_TONE[severity]])}>{children}</p>
    </div>
  );
}

// --- the metric grid --------------------------------------------------------

/**
 * The aligned part of the card: a fixed label column and one left-aligned
 * content column. Every row shares the grid, which is what makes sparklines and
 * values line up down the card without a single alignment class per row.
 */
export function ReportRows({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1",
        className
      )}
    >
      {children}
    </dl>
  );
}

/**
 * One row of the grid. The label sits in the fixed column; everything else
 * flows left-aligned in the content column and wraps within it — so a long
 * trailing note pushes to a second line instead of shoving the sparkline right.
 */
export function ReportRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="truncate text-text-dimmed">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">{children}</dd>
    </>
  );
}

/**
 * A metric value. `tabular-nums` so digits keep their column when a card
 * re-renders with different numbers.
 */
export function ReportValue({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: ReportTone;
}) {
  return <span className={cn("tabular-nums", TONE_TEXT[tone])}>{children}</span>;
}

/**
 * A named thing in the system — a queue, a task, a region. Green, because a
 * concrete entity is the useful part of a line, and because it reads as data
 * rather than as prose.
 */
export function ReportEntity({ children }: { children: ReactNode }) {
  return <span className="text-success">{children}</span>;
}

/**
 * The sparkline. It renders immediately after the label in the content column,
 * left-aligned, at the same monospace size as everything else so its bars sit on
 * the text grid.
 */
export function ReportSpark({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 tracking-tight text-text-dimmed" aria-hidden>
      {children}
    </span>
  );
}

// --- links and actions ------------------------------------------------------

/**
 * A link inside the report. Uses the library's link colour token plus a
 * permanent underline: on the near-black panel the violet alone was doing all
 * the work and losing, and an underline also means the link isn't identified by
 * colour only.
 */
export function ReportLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const external = /^https?:\/\//i.test(href);
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={cn(
        "text-text-link underline decoration-text-link/50 underline-offset-2 transition hover:text-text-bright hover:decoration-text-bright/50 focus-custom",
        className
      )}
    >
      {children}
    </a>
  );
}

/** The footer row. Buttons, wrapping, never a bare clickable sentence. */
export function ReportActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/**
 * A footer action, as a real button. `href` gives a link button (used for docs
 * and other external targets); otherwise it's a button that reports the click
 * back to the host, which decides what happens.
 *
 * Nothing clickable on the card is styled as text — that's the whole point of
 * this component existing rather than an `<a>` with an arrow in front of it.
 *
 * The one override on the library button is the monospace face, so the footer
 * belongs to the terminal card it sits in.
 */
export function ReportActionButton({
  label,
  tone,
  href,
  onClick,
  LeadingIcon,
  TrailingIcon,
}: {
  label: string;
  tone: ReportActionTone;
  href?: string;
  onClick?: () => void;
  LeadingIcon?: RenderIcon;
  TrailingIcon?: RenderIcon;
}) {
  const variant = REPORT_ACTION_VARIANT[tone];

  if (href) {
    return (
      <LinkButton
        to={href}
        variant={variant}
        LeadingIcon={LeadingIcon}
        TrailingIcon={TrailingIcon}
        className="font-mono"
      >
        {label}
      </LinkButton>
    );
  }

  return (
    <Button
      type="button"
      variant={variant}
      onClick={onClick}
      LeadingIcon={LeadingIcon}
      TrailingIcon={TrailingIcon}
      className="font-mono"
    >
      {label}
    </Button>
  );
}

/**
 * A footer entry that states an option rather than offering one ("nothing to
 * do", "or do nothing — the backlog drains in ~26 min"). Deliberately not a
 * button: there is nothing to click.
 */
export function ReportActionNote({ children }: { children: ReactNode }) {
  return <span className="text-text-dimmed">{children}</span>;
}
