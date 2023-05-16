import * as React from "react";
import { cn } from "~/utils/cn";
import { Header3 } from "./Headers";

export function Label({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <Header3 className={cn(className)}>{children}</Header3>;
}
