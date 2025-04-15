import { type ReactNode } from "react";
import { cn } from "~/utils/cn";
import { Header3 } from "../Headers";

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-grid-bright bg-background-bright pb-2 pt-4",
        className
      )}
    >
      {children}
    </div>
  );
};

const CardHeader = ({ children }: { children: ReactNode }) => {
  return <Header3 className="flex items-center justify-between gap-2 px-4">{children}</Header3>;
};

const CardContent = ({ children }: { children: ReactNode }) => {
  return <div className="px-2">{children}</div>;
};

const CardAccessory = ({ children }: { children: ReactNode }) => {
  return <div className="flex-shrink-0">{children}</div>;
};

Card.Header = CardHeader;
Card.Content = CardContent;
Card.Accessory = CardAccessory;
