import { cn } from "~/utils/cn";

const inlineCode =
  "px-1 py-0.5 rounded border border-grid-bright bg-tertiary text-text-bright font-mono text-wrap";

const variants = {
  "extra-extra-small": "text-xxs",
  "extra-small": "text-xs",
  small: "text-sm",
  base: "text-base",
};

export type InlineCodeVariant = keyof typeof variants;

type InlineCodeProps = {
  children: React.ReactNode;
  variant?: InlineCodeVariant;
  className?: string;
};

export function InlineCode({ variant = "small", children, className }: InlineCodeProps) {
  return <code className={cn(inlineCode, variants[variant], className)}>{children}</code>;
}
