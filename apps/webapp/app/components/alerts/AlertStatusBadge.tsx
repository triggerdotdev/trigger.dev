import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import type { AlertListRowStatus } from "~/presenters/v3/alertListRow";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";

const STYLES: Record<AlertListRowStatus, string> = {
  needs_attention: "bg-error/10 text-error",
  active: "bg-success/10 text-success",
  inactive: "bg-charcoal-600/20 text-text-dimmed",
};

const BRIGHT_STYLES: Record<AlertListRowStatus, string> = {
  needs_attention: "bg-error/10 text-error system:bg-error system:text-white",
  active: "bg-success/10 text-success system:bg-success system:text-white",
  inactive: "bg-charcoal-600/20 text-text-dimmed",
};

const LABELS: Record<AlertListRowStatus, string> = {
  needs_attention: "Needs attention",
  active: "Active",
  inactive: "Inactive",
};

const ALERT_STATUS_DESCRIPTIONS: Record<AlertListRowStatus, string> = {
  active: "Evaluating on schedule, no attention needed.",
  needs_attention: "Condition met — raised and waiting for you to mark it resolved.",
  inactive: "Not evaluating; activate to resume.",
};

const AlertStatusChip = forwardRef<
  HTMLSpanElement,
  {
    status: AlertListRowStatus;
    label?: string;
    prominence?: "subtle" | "bright";
  } & ComponentPropsWithoutRef<"span">
>(function AlertStatusChip({ status, className, label, prominence = "subtle", ...props }, ref) {
  return (
    <span
      {...props}
      ref={ref}
      className={cn(
        "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium",
        prominence !== "bright" && "contrast-chip",
        (prominence === "bright" ? BRIGHT_STYLES : STYLES)[status],
        className
      )}
    >
      {label ?? LABELS[status]}
    </span>
  );
});

export function AlertStatusBreakdown() {
  return (
    <div className="flex flex-col gap-2.5">
      {(["active", "needs_attention", "inactive"] as const).map((status) => (
        <div key={status} className="flex flex-col items-start gap-1">
          <AlertStatusChip status={status} />
          <span>{ALERT_STATUS_DESCRIPTIONS[status]}</span>
        </div>
      ))}
    </div>
  );
}

export function AlertStatusBadge({
  status,
  className,
  label,
  prominence = "subtle",
  extra,
}: {
  status: AlertListRowStatus;
  className?: string;
  label?: string;
  prominence?: "subtle" | "bright";
  extra?: ReactNode;
}) {
  const badge = (
    <AlertStatusChip status={status} className={className} label={label} prominence={prominence} />
  );

  return (
    <SimpleTooltip
      button={badge}
      content={
        extra ? (
          <div className="flex flex-col gap-1">
            <span>{ALERT_STATUS_DESCRIPTIONS[status]}</span>
            <span>{extra}</span>
          </div>
        ) : (
          ALERT_STATUS_DESCRIPTIONS[status]
        )
      }
      side="top"
      asChild
      disableHoverableContent
    />
  );
}
