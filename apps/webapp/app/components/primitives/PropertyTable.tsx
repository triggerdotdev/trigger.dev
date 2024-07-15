import { type ReactNode } from "react";
import { Paragraph } from "./Paragraph";
import { cn } from "~/utils/cn";

export function PropertyTable({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-[auto,1fr] items-center gap-x-4 gap-y-2", className)}>
      {children}
    </div>
  );
}

export type PropertyProps = {
  label: ReactNode;
  labelClassName?: string;
  children: ReactNode;
};

export function Property({ label, labelClassName, children }: PropertyProps) {
  return (
    <>
      <div className={labelClassName}>
        {typeof label === "string" ? <Paragraph variant="small">{label}</Paragraph> : label}
      </div>
      <div>
        {typeof children === "string" ? (
          <Paragraph variant="small/bright">{children}</Paragraph>
        ) : (
          children
        )}
      </div>
    </>
  );
}
