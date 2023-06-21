import { cn } from "@/utils/cn";

const header1Variants = {
  "small/bold": "font-title font-bold text-3xl pb-4",
  "base/bold": "font-title font-bold text-4xl pb-4",
  "large/bold":
    "font-title font-bold sm:text-5xl sm:leading-tight sm:pb-6 text-3xl pb-6",
  "extra-large/bold":
    "font-title font-bold text-4xl sm:text-5xl lg:text-6xl leading-tight sm:leading-[3rem] lg:leading-[4rem] pb-6",
};

const header2Variants = {
  "small/semibold": "font-title font-semibold text-2xl pb-4",
  "base/bold": "font-title font-bold sm:text-3xl pb-4 text-2xl sm:pb-6",
  "large/bold": "font-title font-bold sm:text-4xl text-3xl pb-6",
};

const header3Variants = {
  "small/inter": "font-sans font-normal sm:text-xl text-lg pb-8",
  small: "font-title font-normal text-xl pb-2",
  "small/semibold":
    "font-title sm:font-semibold sm:text-xl pb-2 font-medium text-base",
  "base/semibold": "font-title font-semibold sm:text-2xl text-xl pb-2",
  "large/semibold": "font-title font-semibold text-3xl pb-4",
};

const header4Variants = {
  "extra-small/medium": "font-title font-semibold text-base pb-1",
  "small/semibold":
    "font-title sm:font-semibold sm:text-lg text-base font-medium pb-2 sm:leading-tight",
  "base/semibold": "font-title font-semibold text-xl pb-2",
  "large/semibold": "font-title font-semibold text-2xl pb-4",
};

type HeaderProps = {
  className?: string;
  children: React.ReactNode;
  textCenter?: boolean;
  removeBottomPadding?: boolean;
  id?: string;
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
  removeBottomPadding,
  className,
  children,
  id,
}: Header1Props) {
  return (
    <h1
      className={cn(
        "text-slate-200",
        header1Variants[variant],
        textCenter ? "text-center" : "",
        removeBottomPadding ? "pb-0" : "",
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
  removeBottomPadding,
  className,
  children,
}: Header2Props) {
  return (
    <h2
      className={cn(
        "text-slate-200",
        header2Variants[variant],
        textCenter ? "text-center" : "",
        removeBottomPadding ? "pb-0" : "",
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
  removeBottomPadding,
  className,
  children,
}: Header3Props) {
  return (
    <h3
      className={cn(
        "text-slate-200",
        header3Variants[variant],
        textCenter ? "text-center" : "",
        removeBottomPadding ? "pb-0" : "",
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
  removeBottomPadding,
  className,
  children,
}: Header4Props) {
  return (
    <h4
      className={cn(
        "text-slate-200",
        header4Variants[variant],
        textCenter ? "text-center" : "",
        removeBottomPadding ? "pb-0" : "",
        className
      )}
    >
      {children}
    </h4>
  );
}
