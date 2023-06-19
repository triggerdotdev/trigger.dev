import { cn } from "@/utils/cn";

const paragraphVariants = {
  extraSmall: "text-xs pb-4 last:pb-0",
  "extra-small/medium": "font-semibold text-xs",
  small: "text-sm pb-6 last:pb-0 leading-normal",
  "small/medium": "text-sm font-medium pb-6 last:pb-0",
  "small/bold": "text-sm font-bold pb-6 last:pb-0",
  base: "text-base pb-8 last:pb-0",
  "base/medium": "text-base font-medium pb-8 last:pb-0",
  "base/bold": "text-base font-bold pb-8 last:pb-0",
  large: "text-base md:text-lg pb-6 last:pb-0",
  "extraLarge/semiBold": "font-semibold sm:text-2xl text-xl pb-2", // this is the same as Header3 base/semibold
};

type ParagraphProps = {
  variant: keyof typeof paragraphVariants;
  className?: string;
  removeBottomPadding?: boolean;
  children: React.ReactNode;
  textCenter?: boolean;
  capitalize?: boolean;
};

export function Paragraph({
  variant,
  removeBottomPadding,
  textCenter,
  capitalize,
  className,
  children,
}: ParagraphProps) {
  return (
    <p
      className={cn(
        "font-sans text-slate-400",
        paragraphVariants[variant],
        removeBottomPadding ? "pb-0" : "",
        textCenter ? "text-center" : "",
        capitalize ? "uppercase tracking-wider" : "",
        className
      )}
    >
      {children}
    </p>
  );
}
