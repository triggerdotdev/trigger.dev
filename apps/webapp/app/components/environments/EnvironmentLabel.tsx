import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { cn } from "~/utils/cn";
import { sortEnvironments } from "~/utils/environmentSort";
import { SimpleTooltip } from "../primitives/Tooltip";
import {
  DeployedEnvironmentIcon,
  DevEnvironmentIcon,
  ProdEnvironmentIcon,
} from "~/assets/icons/EnvironmentIcons";

type Environment = Pick<RuntimeEnvironment, "type">;

export function EnvironmentIcon({
  environment,
  className,
}: {
  environment: Environment;
  className?: string;
}) {
  switch (environment.type) {
    case "DEVELOPMENT":
      return (
        <DevEnvironmentIcon className={cn(environmentTextClassName(environment), className)} />
      );
    case "PRODUCTION":
      return (
        <ProdEnvironmentIcon className={cn(environmentTextClassName(environment), className)} />
      );
    case "STAGING":
    case "PREVIEW":
      return (
        <DeployedEnvironmentIcon className={cn(environmentTextClassName(environment), className)} />
      );
  }
}

export function EnvironmentCombo({
  environment,
  className,
}: {
  environment: Environment;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1.5 text-sm text-text-bright", className)}>
      <EnvironmentIcon environment={environment} className="size-4" />
      <EnvironmentLabel environment={environment} />
    </span>
  );
}

export function EnvironmentLabel({
  environment,
  className,
}: {
  environment: Environment;
  className?: string;
}) {
  return (
    <span className={cn(environmentTextClassName(environment), className)}>
      {environmentFullTitle(environment)}
    </span>
  );
}

export function environmentTitle(environment: Environment, username?: string) {
  switch (environment.type) {
    case "PRODUCTION":
      return "Prod";
    case "STAGING":
      return "Staging";
    case "DEVELOPMENT":
      return username ? `Dev: ${username}` : "Dev: You";
    case "PREVIEW":
      return "Preview";
  }
}

export function environmentFullTitle(environment: Environment) {
  switch (environment.type) {
    case "PRODUCTION":
      return "Production";
    case "STAGING":
      return "Staging";
    case "DEVELOPMENT":
      return "Development";
    case "PREVIEW":
      return "Preview";
  }
}

export function environmentTypeTitle(environment: Environment) {
  switch (environment.type) {
    case "PRODUCTION":
      return "Prod";
    case "STAGING":
      return "Staging";
    case "DEVELOPMENT":
      return "Dev";
    case "PREVIEW":
      return "Preview";
  }
}

export function environmentColorClassName(environment: Environment) {
  switch (environment.type) {
    case "PRODUCTION":
      return "bg-green-500";
    case "STAGING":
      return "bg-amber-500";
    case "DEVELOPMENT":
      return "bg-pink-500";
    case "PREVIEW":
      return "bg-yellow-500";
  }
}

export function environmentBorderClassName(environment: Environment) {
  switch (environment.type) {
    case "PRODUCTION":
      return "border-green-500/50";
    case "STAGING":
      return "border-amber-500/50";
    case "DEVELOPMENT":
      return "border-pink-500/50";
    case "PREVIEW":
      return "border-yellow-500/50";
  }
}

export function environmentTextClassName(environment: Environment) {
  switch (environment.type) {
    case "PRODUCTION":
      return "text-green-500";
    case "STAGING":
      return "text-amber-500";
    case "DEVELOPMENT":
      return "text-pink-500";
    case "PREVIEW":
      return "text-yellow-500";
  }
}
