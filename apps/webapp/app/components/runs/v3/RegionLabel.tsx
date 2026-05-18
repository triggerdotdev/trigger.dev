import { FlagIcon } from "~/assets/icons/RegionIcons";
import { cn } from "~/utils/cn";

type RegionLabelProps = {
  region: {
    name: string;
    location?: string | null;
  };
  className?: string;
  iconClassName?: string;
};

export function RegionLabel({ region, className, iconClassName }: RegionLabelProps) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      {region.location ? (
        <FlagIcon region={region.location} className={cn("size-5", iconClassName)} />
      ) : null}
      {region.name}
    </span>
  );
}
