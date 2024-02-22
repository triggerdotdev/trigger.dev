import { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { cn } from "~/utils/cn";

type Environment = Pick<RuntimeEnvironment, "type">;

export function EnvironmentLabel({
  environment,
  userName,
  className,
}: {
  environment: Environment;
  userName?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-4 items-center justify-center rounded-[2px] px-1 text-xxs font-medium uppercase tracking-wider text-midnight-900",
        environmentColorClassName(environment),
        className
      )}
    >
      {environmentTitle(environment, userName)}
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
      return username ? `Dev: ${username}` : "Dev";
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
      return "border-green-500";
    case "STAGING":
      return "border-amber-500";
    case "DEVELOPMENT":
      return "border-pink-500";
    case "PREVIEW":
      return "border-yellow-500";
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
