import { cn } from "~/utils/cn";
import { type ReactNode } from "react";
import { Header2 } from "../Headers";

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => {
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-grid-bright bg-background-bright p-4",
        className
      )}
    >
      {children}
    </div>
  );
};

const CardHeader = ({ children, className }: { children: ReactNode; className?: string }) => {
  return <Header2 className={cn("flex flex-col space-y-1.5", className)}>{children}</Header2>;
};

const CardContent = ({ children, className }: { children: ReactNode; className?: string }) => {
  return <div className={cn("pt-4", className)}>{children}</div>;
};

Card.Header = CardHeader;
Card.Content = CardContent;
