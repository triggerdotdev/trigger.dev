import { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { cn } from "~/utils/cn";
import { environmentTextClassName, environmentTitle } from "./environments/EnvironmentLabel";

type Environment = Pick<RuntimeEnvironment, "type">;

type VersionLabelProps = {
  environment: Environment;
  userName?: string;
  version: string;
};

export function VersionLabel({ environment, userName, version }: VersionLabelProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center justify-stretch justify-items-stretch rounded-sm border border-midnight-700 text-xxs"
      )}
    >
      <div className="px-1 text-xs tabular-nums text-dimmed">v{version}</div>
      <div
        className={cn(
          "inline-flex items-center justify-center rounded-r-sm border-l border-midnight-700 px-1 text-xxs font-medium uppercase tracking-wider",
          environmentTextClassName(environment)
        )}
      >
        {environmentTitle(environment, userName)}
      </div>
    </div>
  );
}
