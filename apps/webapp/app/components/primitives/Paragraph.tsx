import { cn } from "~/utils/cn";

const paragraphVariants = {
  base: "font-sans text-base font-normal text-slate-400 mb-2",
  "base/bright": "font-sans text-base text-slate-200 mb-2",
  small: "font-sans text-sm font-normal text-slate-400 mb-1.5",
  "small/bright": "font-sans text-sm text-slate-200 mb-1.5",
  "extra-small": "font-sans text-xs font-normal text-slate-400",
  "extra-small/bright": "font-sans text-xs text-slate-200",
  "extra-small/mono": "font-mono text-xs text-slate-400",
  "extra-small/bright/mono": "font-mono text-xs text-slate-200",
  "extra-small/caps":
    "font-sans text-xs uppercase tracking-wide font-normal text-slate-400",
  "extra-small/bright/caps":
    "font-sans text-xs uppercase tracking-wide font-normal text-slate-200",
  "extra-extra-small": "font-sans text-xxs text-slate-400",
  "extra-extra-small/bright": "font-sans text-xxs text-slate-200",
  "extra-extra-small/caps":
    "font-sans text-xxs uppercase tracking-wide font-normal text-slate-400",
  "extra-extra-small/bright/caps":
    "font-sans text-xxs uppercase tracking-wide font-normal text-slate-200",
};

//Todo: And leading to the paragraph variants above.

type ParagraphProps = {
  variant?: keyof typeof paragraphVariants;
  className?: string;
  children: React.ReactNode;
};

export function Paragraph({
  variant = "base",
  className,
  children,
}: ParagraphProps) {
  return (
    <p className={cn(paragraphVariants[variant], className)}>{children}</p>
  );
}
