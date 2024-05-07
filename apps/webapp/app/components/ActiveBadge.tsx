import { cn } from "~/utils/cn";

const variant = {
  small:
    "py-[0.25rem] px-1.5 text-xxs font-normal inline-flex items-center justify-center whitespace-nowrap rounded-[0.125rem]",
  normal:
    "py-1 px-1.5 text-xs font-normal inline-flex items-center justify-center whitespace-nowrap rounded-sm",
};

type ActiveBadgeProps = {
  active: boolean;
  className?: string;
  badgeSize?: keyof typeof variant;
};

export function ActiveBadge({ active, className, badgeSize = "normal" }: ActiveBadgeProps) {
  switch (active) {
    case true:
      return (
        <span className={cn(variant[badgeSize], "bg-charcoal-800 text-green-500", className)}>
          Active
        </span>
      );
    case false:
      return (
        <span className={cn(variant[badgeSize], "bg-charcoal-800 text-text-dimmed", className)}>
          Disabled
        </span>
      );
  }
}

export function MissingIntegrationBadge({
  className,
  badgeSize = "normal",
}: {
  className?: string;
  badgeSize?: keyof typeof variant;
}) {
  return (
    <span className={cn(variant[badgeSize], "bg-error text-white", className)}>
      Missing Integration
    </span>
  );
}

export function NewBadge({
  className,
  badgeSize = "normal",
}: {
  className?: string;
  badgeSize?: keyof typeof variant;
}) {
  return (
    <span className={cn(variant[badgeSize], "bg-green-600 text-background-dimmed", className)}>
      New!
    </span>
  );
}
