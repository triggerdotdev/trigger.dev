import { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { cn } from "~/utils/cn";

type Environment = Pick<RuntimeEnvironment, "type" | "slug">;

export function EnvironmentLabel({
  environment,
  className,
}: {
  environment: Environment;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "rounded-sm px-1 py-0.5 text-xxs font-medium uppercase text-slate-1000",
        environmentColorClassName(environment),
        className
      )}
    >
      {environmentTitle(environment)}
    </span>
  );
}

export function environmentTitle(environment: Environment) {
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
