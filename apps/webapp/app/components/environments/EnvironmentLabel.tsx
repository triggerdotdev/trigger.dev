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
const variants = {
  small: "h-4 text-xxs px-[0.1875rem] rounded-[2px]",
  large: "h-6 text-xs px-1.5 rounded",
};

export function EnvironmentTypeLabel({
  environment,
  size = "small",
  className,
}: {
  environment: Environment;
  size?: keyof typeof variants;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-midnight-900 inline-flex items-center justify-center whitespace-nowrap border font-medium uppercase tracking-wider",
        environmentBorderClassName(environment),
        environmentTextClassName(environment),
        variants[size],
        className
      )}
    >
      {environmentTypeTitle(environment)}
    </span>
  );
}

export function EnvironmentLabel({
  environment,
  size = "small",
  userName,
  className,
}: {
  environment: Environment;
  size?: keyof typeof variants;
  userName?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-midnight-900 inline-flex items-center justify-center whitespace-nowrap border font-medium uppercase tracking-wider",
        environmentBorderClassName(environment),
        environmentTextClassName(environment),
        variants[size],
        className
      )}
    >
      {environmentTitle(environment, userName)}
    </span>
  );
}

type EnvironmentWithUsername = Environment & { userName?: string };

export function EnvironmentLabels({
  environments,
  size = "small",
  className,
}: {
  environments: EnvironmentWithUsername[];
  size?: keyof typeof variants;
  className?: string;
}) {
  const devEnvironments = sortEnvironments(
    environments.filter((env) => env.type === "DEVELOPMENT")
  );
  const firstDevEnvironment = devEnvironments[0];
  const otherDevEnvironments = devEnvironments.slice(1);
  const otherEnvironments = environments.filter((env) => env.type !== "DEVELOPMENT");

  return (
    <div className={cn("flex items-baseline gap-2", className)}>
      {firstDevEnvironment && (
        <EnvironmentLabel
          environment={firstDevEnvironment}
          userName={firstDevEnvironment.userName}
          size={size}
        />
      )}
      {otherDevEnvironments.length > 0 ? (
        <SimpleTooltip
          disableHoverableContent
          button={
            <span
              className={cn(
                "inline-flex items-center justify-center whitespace-nowrap border font-medium uppercase tracking-wider",
                environmentBorderClassName({ type: "DEVELOPMENT" }),
                environmentTextClassName({ type: "DEVELOPMENT" }),
                variants[size]
              )}
            >
              +{otherDevEnvironments.length}
            </span>
          }
          content={
            <div className="flex gap-1 py-1">
              {otherDevEnvironments.map((environment, index) => (
                <EnvironmentLabel
                  key={index}
                  environment={environment}
                  userName={environment.userName}
                  size={size}
                />
              ))}
            </div>
          }
        />
      ) : null}
      {otherEnvironments.map((environment, index) => (
        <EnvironmentLabel
          key={index}
          environment={environment}
          userName={environment.userName}
          size={size}
        />
      ))}
    </div>
  );
}

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

export function FullEnvironmentCombo({
  environment,
  className,
}: {
  environment: Environment;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2 text-sm text-text-bright", className)}>
      <EnvironmentIcon environment={environment} className="size-4" />
      <span>{environmentFullTitle(environment)}</span>
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
