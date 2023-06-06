import { cn } from "~/utils/cn";

const inlineCode =
  "px-1 py-0.5 rounded border border-slate-800 bg-midnight-850 text-sky-200 font-mono";

const variants = {
  "extra-extra-small": "text-xxs",
  "extra-small": "text-xs",
  small: "text-sm",
  base: "text-base",
};

type InlineCodeProps = {
  children: React.ReactNode;
};

type VariantProps = InlineCodeProps & {
  variant?: keyof typeof variants;
};

export function InlineCode({ variant = "small", children }: VariantProps) {
  return <code className={cn(inlineCode, variants[variant])}>{children}</code>;
}
