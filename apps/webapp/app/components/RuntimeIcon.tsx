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

  // Default to Node.js if no runtime is specified
  const effectiveRuntime = parsedRuntime || {
    runtime: "node" as const,
    originalRuntime: "node",
    displayName: "Node.js",
  };

  const icon = getIcon(effectiveRuntime.runtime, className);
  const formattedText = formatRuntimeWithVersion(effectiveRuntime.originalRuntime, runtimeVersion);

  if (withLabel) {
    return (
      <span className="flex items-center gap-1">
        {icon}
        <span>{formattedText}</span>
      </span>
    );
  }

  if (typeof icon === "object" && "type" in icon) {
    return (
      <SimpleTooltip button={icon} content={formattedText} side="top" disableHoverableContent />
    );
  }

  return icon;
}
