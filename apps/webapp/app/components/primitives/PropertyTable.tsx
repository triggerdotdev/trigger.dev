import { type ReactNode } from "react";
import { Paragraph } from "./Paragraph";
import { cn } from "~/utils/cn";

type ChildrenClassName = {
  children: ReactNode;
  className?: string;
};

function PropertyTable({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-y-3", className)}>{children}</div>;
}

function PropertyItem({ children, className }: ChildrenClassName) {
  return <div className={cn("flex flex-col gap-0 text-sm", className)}>{children}</div>;
}

function PropertyLabel({ children, className }: ChildrenClassName) {
  return <div className={cn("font-medium text-text-bright", className)}>{children}</div>;
}

function PropertyValue({ children, className }: ChildrenClassName) {
  return <div className={cn("text-text-dimmed", className)}>{children}</div>;
}

export {
  PropertyTable as Table,
  PropertyItem as Item,
  PropertyLabel as Label,
  PropertyValue as Value,
};
