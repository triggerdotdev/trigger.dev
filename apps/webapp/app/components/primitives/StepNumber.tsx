import { cn } from "~/utils/cn";
import { Header2 } from "./Headers";

export function StepNumber({
  stepNumber,
  active = false,
  complete = false,
  title,
  className,
}: {
  stepNumber?: string;
  active?: boolean;
  complete?: boolean;
  title?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mr-3", className)}>
      {active ? (
        <div className="flex items-center gap-x-3">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-green-600 py-1 text-xs font-semibold text-slate-900 shadow">
            {stepNumber}
          </span>
          <Header2>{title}</Header2>
        </div>
      ) : (
        <div className="flex items-center gap-x-3">
          <span className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 py-1 text-xs font-semibold text-dimmed shadow">
            {complete ? "✓" : stepNumber}
          </span>
          <Header2>{title}</Header2>
        </div>
      )}
    </div>
  );
}
