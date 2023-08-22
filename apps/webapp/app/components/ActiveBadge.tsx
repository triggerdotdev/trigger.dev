import { cn } from "~/utils/cn";

type ActiveBadgeProps = {
  active: boolean;
  className?: string;
};

const badgeStyle =
  "inline-flex py-1 items-center justify-center whitespace-nowrap rounded-sm px-1.5 text-xs font-normal";

export function ActiveBadge({ active, className }: ActiveBadgeProps) {
  switch (active) {
    case true:
      return (
        <span className={cn(badgeStyle, "bg-slate-800 text-green-500", className)}>Active</span>
      );
    case false:
      return (
        <span className={cn(badgeStyle, "bg-slate-800 text-dimmed", className)}>Disabled</span>
      );
  }
}

export function MissingIntegrationBadge({ className }: { className?: string }) {
  return (
    <span className={cn(badgeStyle, "bg-rose-600 text-white", className)}>Missing Integration</span>
  );
}

export function NewBadge({ className }: { className?: string }) {
  return <span className={cn(badgeStyle, "bg-green-600 text-background", className)}>New!</span>;
}
