import { cn } from "~/utils/cn";

const paragraphVariants = {
  base: "font-sans text-base font-normal text-dimmed mb-2",
  "base/bright": "font-sans text-base text-bright mb-2",
  small: "font-sans text-sm font-normal text-dimmed mb-1.5",
  "small/bright": "font-sans text-sm text-bright mb-1.5",
  "extra-small": "font-sans text-xs font-normal text-dimmed",
  "extra-small/bright": "font-sans text-xs text-bright",
  "extra-small/mono": "font-mono text-xs text-dimmed",
  "extra-small/bright/mono": "font-mono text-xs text-bright",
  "extra-small/caps":
    "font-sans text-xs uppercase tracking-wide font-normal text-dimmed",
  "extra-small/bright/caps":
    "font-sans text-xs uppercase tracking-wide font-normal text-bright",
  "extra-extra-small": "font-sans text-xxs text-dimmed",
  "extra-extra-small/bright": "font-sans text-xxs text-bright",
  "extra-extra-small/caps":
    "font-sans text-xxs uppercase tracking-wide font-normal text-dimmed",
  "extra-extra-small/bright/caps":
    "font-sans text-xxs uppercase tracking-wide font-normal text-bright",
};

//Todo: And leading to the paragraph variants above.

type ParagraphProps = {
  variant?: keyof typeof paragraphVariants;
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLParagraphElement>;

export function Paragraph({
  variant = "base",
  className,
  children,
  ...props
}: ParagraphProps) {
  return (
    <p className={cn(paragraphVariants[variant], className)} {...props}>
      {children}
    </p>
  );
}
