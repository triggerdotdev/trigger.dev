import { cn } from "~/utils/cn";

const variants = {
  small:
    "text-xxs font-medium py-0.25 min-w-[14px] rounded-[2px] px-0.5 border border-bright/40 text-dimmed group-hover:border-bright/60 group-hover:text-bright transition",
  medium:
    "text-[0.6rem] leading-[1.13rem] min-w-[20px] px-1 rounded-[3px] border border-bright/40 text-dimmed group-hover:border-bright/60 group-hover:text-bright transition",
};

export type ShortcutKeyVariant = keyof typeof variants;

type ShortcutKeyProps = {
  shortcut: string;
  variant: ShortcutKeyVariant;
  className?: string;
};

export function ShortcutKey({
  shortcut,
  variant,
  className,
}: ShortcutKeyProps) {
  return <span className={cn(variants[variant], className)}>{shortcut}</span>;
}
