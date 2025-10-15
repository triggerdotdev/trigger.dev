import {
  CheckCircleIcon,
  NoSymbolIcon,
  RectangleStackIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import type { SandboxStatus as SandboxStatusType } from "@trigger.dev/database";
import assertNever from "assert-never";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

export function SandboxStatus({
  status,
  className,
}: {
  status: SandboxStatusType;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <SandboxStatusIcon status={status} className="h-4 w-4" />
      <SandboxStatusLabel status={status} />
    </span>
  );
}

export function SandboxStatusLabel({ status }: { status: SandboxStatusType }) {
  return <span className={sandboxStatusClassNameColor(status)}>{sandboxStatusTitle(status)}</span>;
}

export function SandboxStatusIcon({
  status,
  className,
}: {
  status: SandboxStatusType;
  className: string;
}) {
  switch (status) {
    case "PENDING":
      return <RectangleStackIcon className={cn(sandboxStatusClassNameColor(status), className)} />;
    case "DEPLOYING":
      return <Spinner className={cn(sandboxStatusClassNameColor(status), className)} />;
    case "DEPLOYED":
      return <CheckCircleIcon className={cn(sandboxStatusClassNameColor(status), className)} />;
    case "CANCELED":
      return <NoSymbolIcon className={cn(sandboxStatusClassNameColor(status), className)} />;
    case "FAILED":
      return <XCircleIcon className={cn(sandboxStatusClassNameColor(status), className)} />;
    default: {
      assertNever(status);
    }
  }
}

export function sandboxStatusClassNameColor(status: SandboxStatusType): string {
  switch (status) {
    case "PENDING":
      return "text-charcoal-500";
    case "DEPLOYING":
      return "text-pending";
    case "DEPLOYED":
      return "text-success";
    case "CANCELED":
      return "text-charcoal-500";
    case "FAILED":
      return "text-error";
    default: {
      assertNever(status);
    }
  }
}

export function sandboxStatusTitle(status: SandboxStatusType): string {
  switch (status) {
    case "PENDING":
      return "Queued…";
    case "DEPLOYING":
      return "Deploying…";
    case "DEPLOYED":
      return "Deployed";
    case "CANCELED":
      return "Canceled";
    case "FAILED":
      return "Failed";
    default: {
      assertNever(status);
    }
  }
}

export const sandboxStatuses: SandboxStatusType[] = [
  "PENDING",
  "DEPLOYING",
  "DEPLOYED",
  "FAILED",
  "CANCELED",
];

export function sandboxStatusDescription(status: SandboxStatusType): string {
  switch (status) {
    case "PENDING":
      return "The sandbox is queued and waiting to be deployed.";
    case "DEPLOYING":
      return "The sandbox environment is being built and deployed.";
    case "DEPLOYED":
      return "The sandbox environment is ready to use.";
    case "CANCELED":
      return "The sandbox deployment was manually canceled.";
    case "FAILED":
      return "The sandbox deployment encountered an error and could not complete.";
    default: {
      assertNever(status);
    }
  }
}
