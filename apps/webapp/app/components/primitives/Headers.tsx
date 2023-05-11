import { cn } from "~/utils/cn";

const header1Styles = "font-sans text-xl leading-7 font-semibold";
const header2Styles =
  "font-sans text-base leading-6 font-semibold text-slate-200 mb-1";
const header3Styles =
  "font-sans text-sm leading-5 font-semibold text-slate-200";

const header1Variants = {
  default: "text-slate-200",
  dimmed: "text-slate-400",
};

type HeaderProps = {
  className?: string;
  children: React.ReactNode;
};

type Header1Props = HeaderProps & {
  variant?: keyof typeof header1Variants;
};

export function Header1({
  variant = "default",
  className,
  children,
}: Header1Props) {
  return (
    <h1 className={cn(header1Styles, header1Variants[variant], className)}>
      {children}
    </h1>
  );
}

export function Header2({ className, children }: HeaderProps) {
  return <h2 className={cn(header2Styles, className)}>{children}</h2>;
}

export function Header3({ className, children }: HeaderProps) {
  return <h3 className={cn(header3Styles, className)}>{children}</h3>;
}
