import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  NoSymbolIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import type { WorkerDeploymentStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

export function DeploymentStatus({
  status,
  isBuilt,
  className,
}: {
  status: WorkerDeploymentStatus;
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

export function DeploymentStatusLabel({
  status,
  isBuilt,
}: {
  status: WorkerDeploymentStatus;
  isBuilt: boolean;
}) {
  return (
    <span className={deploymentStatusClassNameColor(status)}>
      {deploymentStatusTitle(status, isBuilt)}
    </span>
  );
}

export function DeploymentStatusIcon({
  status,
  className,
}: {
  status: WorkerDeploymentStatus;
  className: string;
}) {
  switch (status) {
    case "PENDING":
    case "BUILDING":
    case "DEPLOYING":
      return <Spinner className={cn(deploymentStatusClassNameColor(status), className)} />;
    case "DEPLOYED":
      return <CheckCircleIcon className={cn(deploymentStatusClassNameColor(status), className)} />;
    case "CANCELED":
      return <NoSymbolIcon className={cn(deploymentStatusClassNameColor(status), className)} />;
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

export function deploymentStatusClassNameColor(status: WorkerDeploymentStatus): string {
  switch (status) {
    case "PENDING":
    case "BUILDING":
    case "DEPLOYING":
      return "text-pending";
    case "TIMED_OUT":
    case "CANCELED":
      return "text-charcoal-500";
    case "DEPLOYED":
      return "text-success";
    case "FAILED":
      return "text-error";
    default: {
      assertNever(status);
    }
  }
}

export function deploymentStatusTitle(status: WorkerDeploymentStatus, isBuilt: boolean): string {
  switch (status) {
    case "PENDING":
      return "Pending…";
    case "BUILDING":
      return "Building…";
    case "DEPLOYING":
      return "Deploying…";
    case "DEPLOYED":
      return "Deployed";
    case "CANCELED":
      return "Canceled";
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

// PENDING and CANCELED are not used so are ommited from the UI
export const deploymentStatuses: WorkerDeploymentStatus[] = [
  "BUILDING",
  "DEPLOYING",
  "DEPLOYED",
  "FAILED",
  "TIMED_OUT",
];

export function deploymentStatusDescription(status: WorkerDeploymentStatus): string {
  switch (status) {
    case "PENDING":
      return "The deployment is queued and waiting to be processed.";
    case "BUILDING":
      return "The code is being built and prepared for deployment.";
    case "DEPLOYING":
      return "The deployment is in progress and tasks are being indexed.";
    case "DEPLOYED":
      return "The deployment has completed successfully.";
    case "CANCELED":
      return "The deployment was manually canceled.";
    case "FAILED":
      return "The deployment encountered an error and could not complete.";
    case "TIMED_OUT":
      return "The deployment exceeded the maximum allowed time and was stopped.";
    default: {
      assertNever(status);
    }
  }
}
