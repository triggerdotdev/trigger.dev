import * as React from "react";
import { cn } from "~/utils/cn";
import { Header2, Header3 } from "./Headers";

type LabelProps = React.AllHTMLAttributes<HTMLLabelElement> & {
  className?: string;
  children: React.ReactNode;
  variant?: "medium" | "large";
};

export function Label({
  className,
  children,
  variant = "medium",
  ...props
}: LabelProps) {
  return variant === "medium" ? (
    <Header3 className={cn(className)} {...props}>
      {children}
    </Header3>
  ) : (
    <Header2 className={cn(className)} {...props}>
      {children}
    </Header2>
  );
}
