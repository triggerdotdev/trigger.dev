import { cn } from "~/utils/cn";

const paragraphVariants = {
  base: "text-base",
  "base/semibold": "text-base font-semibold",
  small: "text-sm",
  "small/semibold": "text-sm font-semibold",
  "extra-small": "text-xs font-medium",
  "extra-small/light": "text-xs",
};

type ParagraphProps = {
  variant: keyof typeof paragraphVariants;
  className?: string;
  children: React.ReactNode;
};

export function Paragraph({ variant, className, children }: ParagraphProps) {
  return (
    <p className={cn("text-slate-200", paragraphVariants[variant], className)}>
      {children}
    </p>
  );
}
