import { cn } from "~/utils/cn";
import { type ParagraphVariant } from "./Paragraph";

const listVariants: Record<
  ParagraphVariant,
  { text: string; spacing: string; items: string }
> = {
  base: {
    text: "font-sans text-base font-normal text-text-dimmed",
    spacing: "mb-3",
    items: "space-y-1 [&>li]:gap-1.5",
  },
  "base/bright": {
    text: "font-sans text-base font-normal text-text-bright",
    spacing: "mb-3",
    items: "space-y-1 [&>li]:gap-1.5",
  },
  small: {
    text: "font-sans text-sm font-normal text-text-dimmed",
    spacing: "mb-2",
    items: "space-y-0.5 [&>li]:gap-1",
  },
  "small/bright": {
    text: "font-sans text-sm font-normal text-text-bright",
    spacing: "mb-2",
    items: "space-y-0.5 [&>li]:gap-1",
  },
  "small/dimmed": {
    text: "font-sans text-sm font-normal text-text-dimmed",
    spacing: "mb-2",
    items: "space-y-0.5 [&>li]:gap-1",
  },
  "extra-small": {
    text: "font-sans text-xs font-normal text-text-dimmed",
    spacing: "mb-1.5",
    items: "space-y-0.5 [&>li]:gap-1",
  },
  "extra-small/bright": {
    text: "font-sans text-xs font-normal text-text-bright",
    spacing: "mb-1.5",
    items: "space-y-0.5 [&>li]:gap-1",
  },
  "extra-small/dimmed": {
    text: "font-sans text-xs font-normal text-text-dimmed",
    spacing: "mb-1.5",
    items: "space-y-0.5 [&>li]:gap-1",
  },
  "extra-small/dimmed/mono": {
    text: "font-mono text-xs font-normal text-text-dimmed",
    spacing: "mb-1.5",
    items: "space-y-0.5 [&>li]:gap-1",
  },
  "extra-small/mono": {
    text: "font-mono text-xs font-normal text-text-dimmed",
    spacing: "mb-1.5",
    items: "space-y-0.5 [&>li]:gap-1",
  },
  "extra-small/bright/mono": {
    text: "font-mono text-xs text-text-bright",
    spacing: "mb-1.5",
    items: "space-y-0.5 [&>li]:gap-1",
  },
  "extra-small/caps": {
    text: "font-sans text-xs uppercase tracking-wider font-normal text-text-dimmed",
    spacing: "mb-1.5",
    items: "space-y-0.5 [&>li]:gap-1",
  },
  "extra-small/bright/caps": {
    text: "font-sans text-xs uppercase tracking-wider font-normal text-text-bright",
    spacing: "mb-1.5",
    items: "space-y-0.5 [&>li]:gap-1",
  },
  "extra-extra-small": {
    text: "font-sans text-xxs font-normal text-text-dimmed",
    spacing: "mb-1",
    items: "space-y-0.5 [&>li]:gap-0.5",
  },
  "extra-extra-small/bright": {
    text: "font-sans text-xxs font-normal text-text-bright",
    spacing: "mb-1",
    items: "space-y-0.5 [&>li]:gap-0.5",
  },
  "extra-extra-small/caps": {
    text: "font-sans text-xxs uppercase tracking-wider font-normal text-text-dimmed",
    spacing: "mb-1",
    items: "space-y-0.5 [&>li]:gap-0.5",
  },
  "extra-extra-small/bright/caps": {
    text: "font-sans text-xxs uppercase tracking-wider font-normal text-text-bright",
    spacing: "mb-1",
    items: "space-y-0.5 [&>li]:gap-0.5",
  },
  "extra-extra-small/dimmed/caps": {
    text: "font-sans text-xxs uppercase tracking-wider font-normal text-text-dimmed",
    spacing: "mb-1",
    items: "space-y-0.5 [&>li]:gap-0.5",
  },
};

type UnorderedListProps = {
  variant?: ParagraphVariant;
  className?: string;
  spacing?: boolean;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLUListElement>;

export function UnorderedList({
  variant = "base",
  className,
  spacing = false,
  children,
  ...props
}: UnorderedListProps) {
  const v = listVariants[variant];
  return (
    <ul
      className={cn(
        "list-none [&>li]:flex [&>li]:items-baseline [&>li]:before:shrink-0 [&>li]:before:content-['•']",
        v.text,
        v.items,
        spacing && v.spacing,
        className
      )}
      {...props}
    >
      {children}
    </ul>
  );
}
