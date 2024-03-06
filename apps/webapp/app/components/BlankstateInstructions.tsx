import { cn } from "~/utils/cn";
import { Header2 } from "./primitives/Headers";
import { InformationCircleIcon } from "@heroicons/react/20/solid";

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
    <div className={cn("flex flex-col gap-2 rounded-md border p-4", className)}>
      {title && (
        <div className="flex items-center gap-2">
          <InformationCircleIcon className="size-6 text-text-dimmed" />
          <Header2>{title}</Header2>
        </div>
      )}
      {children}
    </div>
  );
}
