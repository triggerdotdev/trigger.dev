import { type ReactNode } from "react";
import { cn } from "~/utils/cn";
import { Header3 } from "../Headers";

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => {
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-grid-bright bg-background-bright pb-1.5 pt-3",
        className
      )}
    >
      {children}
    </div>
  );
};

const CardHeader = ({ children }: { children: ReactNode }) => {
  return (
    <Header3 className="mb-3 flex items-center justify-between gap-2 px-3">{children}</Header3>
  );
};

const CardContent = ({ children, className }: { children: ReactNode; className?: string }) => {
  return <div className={cn("px-2", className)}>{children}</div>;
};

const CardAccessory = ({ children }: { children: ReactNode }) => {
  return <div className="flex items-center gap-2">{children}</div>;
};

Card.Header = CardHeader;
Card.Content = CardContent;
Card.Accessory = CardAccessory;
