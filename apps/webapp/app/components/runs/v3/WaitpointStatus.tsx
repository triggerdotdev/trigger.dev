import { CheckCircleIcon } from "@heroicons/react/20/solid";
import { type WaitpointStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { TimedOutIcon } from "~/assets/icons/TimedOutIcon";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

export function WaitpointStatusCombo({
  status,
  outputIsError,
  className,
  iconClassName,
}: {
  status: WaitpointStatus;
  outputIsError: boolean;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <WaitpointStatusIcon
        status={status}
        outputIsError={outputIsError}
        className={cn("h-4 w-4", iconClassName)}
      />
      <WaitpointStatusLabel status={status} outputIsError={outputIsError} />
    </span>
  );
}

export function WaitpointStatusLabel({
  status,
  outputIsError,
}: {
  status: WaitpointStatus;
  outputIsError: boolean;
}) {
  return (
    <span className={waitpointStatusClassNameColor(status, outputIsError)}>
      {runStatusTitle(status, outputIsError)}
    </span>
  );
}

export function WaitpointStatusIcon({
  status,
  outputIsError,
  className,
}: {
  status: WaitpointStatus;
  outputIsError: boolean;
  className: string;
}) {
  switch (status) {
    case "PENDING":
      return (
        <Spinner className={cn(waitpointStatusClassNameColor(status, outputIsError), className)} />
      );
    case "COMPLETED": {
      if (outputIsError) {
        return (
          <TimedOutIcon
            className={cn(waitpointStatusClassNameColor(status, outputIsError), className)}
          />
        );
      }
      return (
        <CheckCircleIcon
          className={cn(waitpointStatusClassNameColor(status, outputIsError), className)}
        />
      );
    }

    default: {
      assertNever(status);
    }
  }
}

export function waitpointStatusClassNameColor(
  status: WaitpointStatus,
  outputIsError: boolean
): string {
  switch (status) {
    case "PENDING":
      return "text-charcoal-500";
    case "COMPLETED": {
      if (outputIsError) {
        return "text-error";
      }
      return "text-success";
    }
    default: {
      assertNever(status);
    }
  }
}

export function runStatusTitle(status: WaitpointStatus, outputIsError: boolean): string {
  switch (status) {
    case "PENDING":
      return "Delayed";
    case "COMPLETED": {
      if (outputIsError) {
        return "Timed out";
      }
      return "Completed";
    }
    default: {
      assertNever(status);
    }
  }
}
