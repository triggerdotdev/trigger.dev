import { CheckCircleIcon, ClockIcon } from "@heroicons/react/20/solid";
import assertNever from "assert-never";
import { type SessionStatus } from "~/services/sessionsRepository/sessionsRepository.server";
import { cn } from "~/utils/cn";

export const allSessionStatuses = ["ACTIVE", "CLOSED", "EXPIRED"] as const satisfies Readonly<
  Array<SessionStatus>
>;

const descriptions: Record<SessionStatus, string> = {
  ACTIVE: "The session is open and can receive input or schedule new runs.",
  CLOSED: "The session was closed; no further input or runs can be triggered against it.",
  EXPIRED: "The session passed its expiry time without being closed explicitly.",
};

export function descriptionForSessionStatus(status: SessionStatus): string {
  return descriptions[status];
}

export function sessionStatusTitle(status: SessionStatus): string {
  switch (status) {
    case "ACTIVE":
      return "Active";
    case "CLOSED":
      return "Closed";
    case "EXPIRED":
      return "Expired";
    default:
      assertNever(status);
  }
}

export function sessionStatusColor(status: SessionStatus): string {
  switch (status) {
    case "ACTIVE":
      return "text-pending";
    case "CLOSED":
      return "text-success";
    case "EXPIRED":
      return "text-text-dimmed";
    default:
      assertNever(status);
  }
}

export function SessionStatusIcon({
  status,
  className,
  pulse = true,
}: {
  status: SessionStatus;
  className: string;
  pulse?: boolean;
}) {
  switch (status) {
    case "ACTIVE":
      return (
        <span className={cn("inline-flex items-center justify-center", className)}>
          <span className="relative flex size-2">
            {pulse && (
              <span className="absolute h-full w-full animate-ping rounded-full border border-pending opacity-100 duration-1000" />
            )}
            <span className="size-2 rounded-full bg-pending" />
          </span>
        </span>
      );
    case "CLOSED":
      return <CheckCircleIcon className={cn(sessionStatusColor(status), className)} />;
    case "EXPIRED":
      return <ClockIcon className={cn(sessionStatusColor(status), className)} />;
    default:
      assertNever(status);
  }
}

export function SessionStatusLabel({ status }: { status: SessionStatus }) {
  return <span className={sessionStatusColor(status)}>{sessionStatusTitle(status)}</span>;
}

export function SessionStatusCombo({
  status,
  className,
  iconClassName,
  pulse = true,
}: {
  status: SessionStatus;
  className?: string;
  iconClassName?: string;
  pulse?: boolean;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <SessionStatusIcon status={status} className={cn("size-4", iconClassName)} pulse={pulse} />
      <SessionStatusLabel status={status} />
    </span>
  );
}
