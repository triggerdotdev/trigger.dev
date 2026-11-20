import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ForwardIcon,
  NoSymbolIcon,
  RectangleStackIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import type { WorkerDeploymentStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

export type DeploymentDisplayStatus = WorkerDeploymentStatus | "SUPERSEDED";

export function deploymentDisplayStatus(
  status: WorkerDeploymentStatus,
  isSuperseded: boolean
): DeploymentDisplayStatus {
  return status === "CANCELED" && isSuperseded ? "SUPERSEDED" : status;
}

export function DeploymentStatus({
  status,
  isBuilt,
  className,
}: {
  status: DeploymentDisplayStatus;
  isBuilt: boolean;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <DeploymentStatusIcon status={status} className="h-4 w-4" />
      <DeploymentStatusLabel status={status} isBuilt={isBuilt} />
    </span>
  );
}

function DeploymentStatusLabel({
  status,
  isBuilt,
}: {
  status: DeploymentDisplayStatus;
  isBuilt: boolean;
}) {
  return (
    // system-mono-label: System themes uncolor the label (see tailwind.css)
    <span className={cn("system-mono-label", deploymentStatusClassNameColor(status))}>
      {deploymentStatusTitle(status, isBuilt)}
    </span>
  );
}

function DeploymentStatusIcon({
  status,
  className,
}: {
  status: DeploymentDisplayStatus;
  className: string;
}) {
  switch (status) {
    case "PENDING":
      return (
        <RectangleStackIcon className={cn(deploymentStatusClassNameColor(status), className)} />
      );
    case "INSTALLING":
    case "BUILDING":
    case "DEPLOYING":
      return <Spinner className={cn(deploymentStatusClassNameColor(status), className)} />;
    case "DEPLOYED":
      return <CheckCircleIcon className={cn(deploymentStatusClassNameColor(status), className)} />;
    case "CANCELED":
      return <NoSymbolIcon className={cn(deploymentStatusClassNameColor(status), className)} />;
    case "SUPERSEDED":
      return <ForwardIcon className={cn(deploymentStatusClassNameColor(status), className)} />;
    case "FAILED":
      return <XCircleIcon className={cn(deploymentStatusClassNameColor(status), className)} />;
    case "TIMED_OUT":
      return (
        <ExclamationTriangleIcon
          className={cn(deploymentStatusClassNameColor(status), className)}
        />
      );
    default: {
      assertNever(status);
    }
  }
}

function deploymentStatusClassNameColor(status: DeploymentDisplayStatus): string {
  switch (status) {
    case "PENDING":
      return "text-text-faint";
    case "INSTALLING":
    case "BUILDING":
    case "DEPLOYING":
      return "text-pending";
    case "TIMED_OUT":
    case "CANCELED":
    case "SUPERSEDED":
      return "text-text-faint";
    case "DEPLOYED":
      return "text-success";
    case "FAILED":
      return "text-error";
    default: {
      assertNever(status);
    }
  }
}

function deploymentStatusTitle(status: DeploymentDisplayStatus, isBuilt: boolean): string {
  switch (status) {
    case "PENDING":
      return "Queued…";
    case "INSTALLING":
      return "Installing…";
    case "BUILDING":
      return "Building…";
    case "DEPLOYING":
      return "Deploying…";
    case "DEPLOYED":
      return "Deployed";
    case "CANCELED":
      return "Canceled";
    case "SUPERSEDED":
      return "Superseded";
    case "TIMED_OUT":
      if (!isBuilt) {
        return "Build timed out";
      }

      return "Indexing timed out";
    case "FAILED":
      if (!isBuilt) {
        return "Build failed";
      }

      return "Indexing failed";
    default: {
      assertNever(status);
    }
  }
}

export const deploymentStatuses: DeploymentDisplayStatus[] = [
  "PENDING",
  "INSTALLING",
  "BUILDING",
  "DEPLOYING",
  "DEPLOYED",
  "FAILED",
  "TIMED_OUT",
  "CANCELED",
  "SUPERSEDED",
];

export function deploymentStatusDescription(status: DeploymentDisplayStatus): string {
  switch (status) {
    case "PENDING":
      return "The deployment is queued and waiting to be processed.";
    case "INSTALLING":
      return "The project dependencies are being installed.";
    case "BUILDING":
      return "The code is being built and prepared for deployment.";
    case "DEPLOYING":
      return "The deployment is in progress and tasks are being indexed.";
    case "DEPLOYED":
      return "The deployment has completed successfully.";
    case "CANCELED":
      return "The deployment was manually canceled.";
    case "SUPERSEDED":
      return "A newer commit was queued for the same environment or branch, so this build was skipped.";
    case "FAILED":
      return "The deployment encountered an error and could not complete.";
    case "TIMED_OUT":
      return "The deployment exceeded the maximum allowed time and was stopped.";
    default: {
      assertNever(status);
    }
  }
}
