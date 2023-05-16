import * as React from "react";
import { cn } from "~/utils/cn";
import { Header3 } from "./Headers";

type LabelProps = React.AllHTMLAttributes<HTMLLabelElement> & {
  className?: string;
  children: React.ReactNode;
};

export function Label({ className, children, ...props }: LabelProps) {
  return (
    <Header3 className={cn(className)} {...props}>
      {children}
    </Header3>
  );
}
