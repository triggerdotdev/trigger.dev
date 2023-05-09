import { cn } from "~/utils/cn";

const header1Variants = {
  "small/bold": "font-title font-bold text-3xl  pb-4",
  "base/bold": "font-title font-bold text-4xl  pb-4",
  "large/bold": "font-title font-bold sm:text-5xl sm:pb-8 text-4xl pb-6",
};

const header2Variants = {
  "small/bold": "font-title font-bold text-2xl pb-4",
  "base/bold": "font-title font-bold text-3xl pb-4",
  "large/bold": "font-title font-bold text-4xl pb-6",
};

const header3Variants = {
  "small/semibold": "font-title font-semibold text-xl pb-2",
  "base/semibold": "font-title font-semibold text-2xl pb-2",
  "large/semibold": "font-title font-semibold text-3xl pb-4",
};

const header4Variants = {
  "small/semibold": "font-title font-semibold text-lg pb-2",
  "base/semibold": "font-title font-semibold text-xl pb-2",
  "large/semibold": "font-title font-semibold text-2xl pb-4",
};

type HeaderProps = {
  className?: string;
  children: React.ReactNode;
  textCenter?: boolean;
};

type Header1Props = HeaderProps & {
  variant: keyof typeof header1Variants;
};

type Header2Props = HeaderProps & {
  variant: keyof typeof header2Variants;
};

type Header3Props = HeaderProps & {
  variant: keyof typeof header3Variants;
};

type Header4Props = HeaderProps & {
  variant: keyof typeof header4Variants;
};

export function Header1({
  variant,
  textCenter,
  className,
  children,
}: Header1Props) {
  return (
    <h1
      className={cn(
        "text-slate-200",
        header1Variants[variant],
        textCenter ? "text-center" : "",
        className
      )}
    >
      {children}
    </h1>
  );
}

export function Header2({
  variant,
  textCenter,
  className,
  children,
}: Header2Props) {
  return (
    <h2
      className={cn(
        "text-slate-200",
        textCenter ? "text-center" : "",
        header2Variants[variant],
        className
      )}
    >
      {children}
    </h2>
  );
}

export function Header3({
  variant,
  textCenter,
  className,
  children,
}: Header3Props) {
  return (
    <h3
      className={cn(
        "text-slate-200",
        textCenter ? "text-center" : "",
        header3Variants[variant],
        className
      )}
    >
      {children}
    </h3>
  );
}

export function Header4({
  variant,
  textCenter,
  className,
  children,
}: Header4Props) {
  return (
    <h4
      className={cn(
        "text-slate-200",
        textCenter ? "text-center" : "",
        header4Variants[variant],
        className
      )}
    >
      {children}
    </h4>
  );
}
