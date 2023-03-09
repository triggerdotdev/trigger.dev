import type { ProjectDeploymentStatus } from ".prisma/client";
import {
  StopCircleIcon,
  CloudIcon,
  ClockIcon,
  CloudArrowUpIcon,
  CubeTransparentIcon,
  ExclamationTriangleIcon,
  NoSymbolIcon,
  PauseCircleIcon,
} from "@heroicons/react/24/solid";
import classNames from "classnames";
import { ReactNode } from "react";

export function deploymentStatusTitle(status: ProjectDeploymentStatus) {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "BUILDING":
      return "Building";
    case "DEPLOYING":
      return "Deploying";
    case "DEPLOYED":
      return "Deployed";
    case "ERROR":
      return "Error";
    case "CANCELLED":
      return "Cancelled";
    case "STOPPING":
      return "Stopping";
    case "STOPPED":
      return "Stopped";
  }
}

const deploymentStatusDotStyles = "h-2.5 w-2.5 rounded-full";

export function deploymentStatusDot(
  status: ProjectDeploymentStatus
): ReactNode {
  switch (status) {
    case "PENDING":
      return (
        <div
          className={classNames(
            deploymentStatusDotStyles,
            "animate-pulse bg-blue-500"
          )}
        ></div>
      );
    case "BUILDING":
      return (
        <div
          className={classNames(
            deploymentStatusDotStyles,
            "animate-pulse bg-blue-500"
          )}
        ></div>
      );
    case "DEPLOYING":
      return (
        <div
          className={classNames(
            deploymentStatusDotStyles,
            "animate-pulse bg-blue-500"
          )}
        ></div>
      );
    case "DEPLOYED":
      return (
        <div
          className={classNames(deploymentStatusDotStyles, "bg-green-500")}
        ></div>
      );
    case "ERROR":
      return (
        <div
          className={classNames(deploymentStatusDotStyles, "bg-rose-500")}
        ></div>
      );
    case "CANCELLED":
      return (
        <div
          className={classNames(deploymentStatusDotStyles, "bg-slate-400")}
        ></div>
      );
    case "STOPPING":
      return (
        <div
          className={classNames(
            deploymentStatusDotStyles,
            "animate-pulse bg-slate-400"
          )}
        ></div>
      );
    case "STOPPED":
      return (
        <div
          className={classNames(deploymentStatusDotStyles, "bg-slate-400")}
        ></div>
      );
  }
}

export function deploymentStatusIcon(
  status: ProjectDeploymentStatus,
  iconSize: "small" | "large"
): ReactNode {
  const largeClasses = "relative h-7 w-7";
  const smallClasses = "relative h-4 w-4";
  switch (status) {
    case "PENDING":
      return (
        <ClockIcon
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-blue-500"
          )}
        />
      );
    case "BUILDING":
      return (
        <CubeTransparentIcon
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-blue-500"
          )}
        />
      );
    case "DEPLOYING":
      return (
        <CloudArrowUpIcon
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-blue-500"
          )}
        />
      );
    case "DEPLOYED":
      return (
        <CloudIcon
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-blue-500"
          )}
        />
      );
    case "ERROR":
      return (
        <ExclamationTriangleIcon
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-rose-500"
          )}
        />
      );
    case "CANCELLED":
      return (
        <NoSymbolIcon
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-slate-400"
          )}
        />
      );
    case "STOPPING":
      return (
        <PauseCircleIcon
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-slate-400"
          )}
        />
      );
    case "STOPPED":
      return (
        <StopCircleIcon
          className={classNames(
            iconSize === "small" ? smallClasses : largeClasses,
            "relative text-slate-400"
          )}
        />
      );
  }
}
