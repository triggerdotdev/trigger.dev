import { cn } from "~/utils/cn";

const paragraphVariants = {
  base: "font-sans text-base font-normal text-dimmed",
  "base/bright": "font-sans text-base font-normal text-bright",
  small: "font-sans text-sm font-normal text-dimmed",
  "small/bright": "font-sans text-sm font-normal text-bright",
  "extra-small": "font-sans text-xs font-normal text-dimmed",
  "extra-small/bright": "font-sans text-xs font-normal text-bright",
  "extra-small/mono": "font-mono text-xs font-normal text-dimmed",
  "extra-small/bright/mono": "font-mono text-xs text-bright",
  "extra-small/caps":
    "font-sans text-xs uppercase tracking-wider font-normal text-dimmed",
  "extra-small/bright/caps":
    "font-sans text-xs uppercase tracking-wider font-normal text-bright",
  "extra-extra-small": "font-sans text-xxs font-normal text-dimmed",
  "extra-extra-small/bright": "font-sans text-xxs font-normal text-bright",
  "extra-extra-small/caps":
    "font-sans text-xxs uppercase tracking-wider font-normal text-dimmed",
  "extra-extra-small/bright/caps":
    "font-sans text-xxs uppercase tracking-wider font-normal text-bright",
};

export type ParagraphVariant = keyof typeof paragraphVariants;

type ParagraphProps = {
  variant?: ParagraphVariant;
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

type TextLinkProps = {
  href: string;
  children: React.ReactNode;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>;

export function TextLink({ href, children, ...props }: TextLinkProps) {
  return (
    <a
      href={href}
      className="text-indigo-500 transition hover:text-indigo-400"
      {...props}
    >
      {children}
    </a>
  );
}
