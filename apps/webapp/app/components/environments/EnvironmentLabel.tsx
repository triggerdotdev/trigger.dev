import { GitBranchIcon } from "lucide-react";
import {
  DeployedEnvironmentIconSmall,
  DevEnvironmentIconSmall,
  ProdEnvironmentIconSmall,
} from "~/assets/icons/EnvironmentIcons";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { cn } from "~/utils/cn";

type Environment = Pick<RuntimeEnvironment, "type"> & { branchName?: string | null };

export function EnvironmentIcon({
  environment,
  className,
}: {
  environment: Environment;
  className?: string;
}) {
  if (environment.branchName) {
    return <GitBranchIcon className={cn(environmentTextClassName(environment), className)} />;
  }

  switch (environment.type) {
    case "DEVELOPMENT":
      return (
        <DevEnvironmentIconSmall className={cn(environmentTextClassName(environment), className)} />
      );
    case "PRODUCTION":
      return (
        <ProdEnvironmentIconSmall
          className={cn(environmentTextClassName(environment), className)}
        />
      );
    case "STAGING":
    case "PREVIEW":
      return (
        <DeployedEnvironmentIconSmall
          className={cn(environmentTextClassName(environment), className)}
        />
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
      <EnvironmentIcon environment={environment} className="size-[1.125rem]" />
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
      {environment.branchName ? environment.branchName : environmentFullTitle(environment)}
    </span>
  );
}

export function environmentTitle(environment: Environment, username?: string) {
  if (environment.branchName) {
    return environment.branchName;
  }

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

export function environmentTextClassName(environment: Environment) {
  switch (environment.type) {
    case "PRODUCTION":
      return "text-prod";
    case "STAGING":
      return "text-staging";
    case "DEVELOPMENT":
      return "text-dev";
    case "PREVIEW":
      return "text-preview";
  }
}
