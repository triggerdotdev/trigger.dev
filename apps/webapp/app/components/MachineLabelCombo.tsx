import { type MachinePresetName } from "@trigger.dev/core/v3";
import { MachineIcon } from "~/assets/icons/MachineIcon";
import { cn } from "~/utils/cn";

export function MachineLabelCombo({
  preset,
  className,
  iconClassName,
  labelClassName,
}: {
  preset?: MachinePresetName | null;
  className?: string;
  iconClassName?: string;
  labelClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <MachineIcon preset={preset ?? undefined} className={cn("size-5", iconClassName)} />
      <MachineLabel preset={preset} className={labelClassName} />
    </span>
  );
}

export function MachineLabel({
  preset,
  className,
}: {
  preset?: MachinePresetName | null;
  className?: string;
}) {
  return (
    <span className={cn("text-text-dimmed", className)}>{formatMachinePresetName(preset)}</span>
  );
}

export function formatMachinePresetName(preset?: MachinePresetName | null): string {
  if (!preset) {
    return "No machine yet";
  }

  switch (preset) {
    case "micro":
      return "Micro";
    case "small-1x":
      return "Small 1x";
    case "small-2x":
      return "Small 2x";
    case "medium-1x":
      return "Medium 1x";
    case "medium-2x":
      return "Medium 2x";
    case "large-1x":
      return "Large 1x";
    case "large-2x":
      return "Large 2x";
    default:
      // Fallback for any unknown presets - capitalize first letter and replace hyphens with spaces
      return (preset as string)
        .split("-")
        .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
  }
}
