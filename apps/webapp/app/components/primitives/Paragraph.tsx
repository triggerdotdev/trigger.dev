import { cn } from "~/utils/cn";

const paragraphVariants = {
  base: "font-sans text-base text-slate-200",
  "base/dimmed": "font-sans text-base font-normal text-slate-400",
  small: "font-sans text-sm text-slate-200",
  "small/dimmed": "font-sans text-sm font-normal text-slate-400",
  "extra-small": "font-sans text-xs text-slate-200",
  "extra-small/dimmed": "font-sans text-xs font-normal text-slate-400",
  "extra-small/mono": "font-mono text-xs text-slate-200",
  "extra-small/dimmed/mono": "font-mono text-xs text-slate-400",
  "extra-small/caps":
    "font-sans text-xs uppercase tracking-wide font-normal text-slate-200",
  "extra-small/dimmed/caps":
    "font-sans text-xs uppercase tracking-wide font-normal text-slate-400",
  "extra-extra-small": "font-sans text-xxs text-slate-200",
  "extra-extra-small/dimmed": "font-sans text-xxs text-slate-400",
  "extra-extra-small/caps":
    "font-sans text-xxs uppercase tracking-wide font-normal text-slate-200",
  "extra-extra-small/dimmed/caps":
    "font-sans text-xxs uppercase tracking-wide font-normal text-slate-400",
};

//Todo: add an xxs font size to tailwind. And leading to the paragraph variants above.

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
