import { CheckCircleIcon } from "@heroicons/react/20/solid";
import { type WaitpointTokenStatus } from "@trigger.dev/core/v3";
import assertNever from "assert-never";
import { TimedOutIcon } from "~/assets/icons/TimedOutIcon";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

export function WaitpointStatusCombo({
  status,
  className,
  iconClassName,
}: {
  status: WaitpointTokenStatus;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <WaitpointStatusIcon status={status} className={cn("h-4 w-4", iconClassName)} />
      <WaitpointStatusLabel status={status} />
    </span>
  );
}

export function WaitpointStatusLabel({ status }: { status: WaitpointTokenStatus }) {
  return (
    <span className={waitpointStatusClassNameColor(status)}>{waitpointStatusTitle(status)}</span>
  );
}

export function WaitpointStatusIcon({
  status,
  className,
}: {
  status: WaitpointTokenStatus;
  className: string;
}) {
  switch (status) {
    case "WAITING":
      return <Spinner className={cn(waitpointStatusClassNameColor(status), className)} />;
    case "TIMED_OUT":
      return <TimedOutIcon className={cn(waitpointStatusClassNameColor(status), className)} />;
    case "COMPLETED":
      return <CheckCircleIcon className={cn(waitpointStatusClassNameColor(status), className)} />;
    default: {
      assertNever(status);
    }
  }
}

export function waitpointStatusClassNameColor(status: WaitpointTokenStatus): string {
  switch (status) {
    case "WAITING":
      return "text-blue-500";
    case "TIMED_OUT":
      return "text-error";
    case "COMPLETED": {
      return "text-success";
    }
    default: {
      assertNever(status);
    }
  }
}

export function waitpointStatusTitle(status: WaitpointTokenStatus): string {
  switch (status) {
    case "WAITING":
      return "Waiting";
    case "TIMED_OUT":
      return "Timed out";
    case "COMPLETED": {
      return "Completed";
    }
    default: {
      assertNever(status);
    }
  }
}
