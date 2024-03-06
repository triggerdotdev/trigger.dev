import { cn } from "~/utils/cn";
import { Header2 } from "./primitives/Headers";

export function BlankstateInstructions({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {title && (
        <div className="flex h-10 items-center border-b border-grid-bright">
          <Header2>{title}</Header2>
        </div>
      )}
      {children}
    </div>
  );
}
