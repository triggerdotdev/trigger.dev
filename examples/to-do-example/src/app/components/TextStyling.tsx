import { cn } from "@/utils/cn";
import React from "react";

const anchorStyle =
  "text-indigo-400 cursor-pointer hover:text-indigo-300 underline-offset-1 hover:underline hover:underline-offset-2 transition duration-300";

type AnchorTextProps = React.DetailedHTMLProps<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  HTMLAnchorElement
> & { href: string; children: React.ReactNode; className?: string };

export function AnchorText({
  children,
  className,
  href,
  ...props
}: AnchorTextProps) {
  return (
    <a className={cn(anchorStyle, className)} {...props}>
      {children}
    </a>
  );
}

type SpanProps = React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLSpanElement>,
  HTMLSpanElement
>;

export function PrimaryGradientText({
  children,
  className,
  ...props
}: SpanProps) {
  return (
    <span
      style={{
        background: "linear-gradient(to right, #E7FF52, #41FF54)",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent",
      }}
    >
      {children}
    </span>
  );
}

export function SecondaryGradientText({
  children,
  className,
  ...props
}: SpanProps) {
  return (
    <span
      style={{
        background: "linear-gradient(to right, #2563EB, #A855F7)",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent",
      }}
    >
      {children}
    </span>
  );
}
