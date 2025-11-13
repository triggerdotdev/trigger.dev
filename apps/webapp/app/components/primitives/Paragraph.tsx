import { cn } from "~/utils/cn";

const paragraphVariants = {
  base: {
    text: "font-sans text-base font-normal text-text-dimmed",
    spacing: "mb-3",
  },
  "base/bright": {
    text: "font-sans text-base font-normal text-text-bright",
    spacing: "mb-3",
  },
  small: {
    text: "font-sans text-sm font-normal text-text-dimmed",
    spacing: "mb-2",
  },
  "small/bright": {
    text: "font-sans text-sm font-normal text-text-bright",
    spacing: "mb-2",
  },
  "small/dimmed": {
    text: "font-sans text-sm font-normal text-text-dimmed",
    spacing: "mb-2",
  },
  "extra-small": {
    text: "font-sans text-xs font-normal text-text-dimmed",
    spacing: "mb-1.5",
  },
  "extra-small/bright": {
    text: "font-sans text-xs font-normal text-text-bright",
    spacing: "mb-1.5",
  },
  "extra-small/dimmed": {
    text: "font-sans text-xs font-normal text-text-dimmed",
    spacing: "mb-1.5",
  },
  "extra-small/dimmed/mono": {
    text: "font-mono text-xs font-normal text-text-dimmed",
    spacing: "mb-1.5",
  },
  "extra-small/mono": {
    text: "font-mono text-xs font-normal text-text-dimmed",
    spacing: "mb-1.5",
  },
  "extra-small/bright/mono": {
    text: "font-mono text-xs text-text-bright",
    spacing: "mb-1.5",
  },
  "extra-small/caps": {
    text: "font-sans text-xs uppercase tracking-wider font-normal text-text-dimmed",
    spacing: "mb-1.5",
  },
  "extra-small/bright/caps": {
    text: "font-sans text-xs uppercase tracking-wider font-normal text-text-bright",
    spacing: "mb-1.5",
  },
  "extra-extra-small": {
    text: "font-sans text-xxs font-normal text-text-dimmed",
    spacing: "mb-1",
  },
  "extra-extra-small/bright": {
    text: "font-sans text-xxs font-normal text-text-bright",
    spacing: "mb-1",
  },

  "extra-extra-small/caps": {
    text: "font-sans text-xxs uppercase tracking-wider font-normal text-text-dimmed",
    spacing: "mb-1",
  },
  "extra-extra-small/bright/caps": {
    text: "font-sans text-xxs uppercase tracking-wider font-normal text-text-bright",
    spacing: "mb-1",
  },
  "extra-extra-small/dimmed/caps": {
    text: "font-sans text-xxs uppercase tracking-wider font-normal text-text-dimmed",
    spacing: "mb-1",
  },
};

export type ParagraphVariant = keyof typeof paragraphVariants;

type ParagraphProps = {
  variant?: ParagraphVariant;
  className?: string;
  spacing?: boolean;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLParagraphElement>;

export function Paragraph({
  variant = "base",
  className,
  spacing = false,
  children,
  ...props
}: ParagraphProps) {
  return (
    <p
      className={cn(
        paragraphVariants[variant].text,
        spacing === true && paragraphVariants[variant].spacing,
        className
      )}
      {...props}
    >
      {children}
    </p>
  );
}
