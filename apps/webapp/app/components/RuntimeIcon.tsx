import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { BunLogoIcon } from "~/assets/icons/BunLogoIcon";
import { NodejsLogoIcon } from "~/assets/icons/NodejsLogoIcon";
import { parseRuntime, formatRuntimeWithVersion, type NormalizedRuntime } from "~/utils/runtime";

interface RuntimeIconProps {
  runtime?: string | null;
  runtimeVersion?: string | null;
  className?: string;
  withLabel?: boolean;
}

const getIcon = (runtime: NormalizedRuntime, className: string) => {
  switch (runtime) {
    case "bun":
      return <BunLogoIcon className={className} />;
    case "node":
      return <NodejsLogoIcon className={className} />;
    default:
      return <span className="text-text-dimmed">–</span>;
  }
};

export function RuntimeIcon({
  runtime,
  runtimeVersion,
  className = "h-4 w-4",
  withLabel = false,
}: RuntimeIconProps) {
  const parsedRuntime = parseRuntime(runtime);

  if (!parsedRuntime) {
    return <span className="text-text-dimmed">–</span>;
  }

  const icon = getIcon(parsedRuntime.runtime, className);
  const formattedText = formatRuntimeWithVersion(parsedRuntime.originalRuntime, runtimeVersion);

  if (withLabel) {
    return (
      <span className="flex items-center gap-1">
        {icon}
        <span>{formattedText}</span>
      </span>
    );
  }

  return <SimpleTooltip button={icon} content={formattedText} side="top" disableHoverableContent />;
}
