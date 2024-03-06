import { cn } from "~/utils/cn";
import { Header2 } from "./Headers";
import { Spinner } from "./Spinner";
import { CheckIcon } from "@heroicons/react/24/solid";

export function StepNumber({
  stepNumber,
  active = false,
  complete = false,
  displaySpinner = false,
  title,
  className,
}: {
  stepNumber?: string;
  active?: boolean;
  complete?: boolean;
  title?: React.ReactNode;
  className?: string;
  displaySpinner?: boolean;
}) {
  return (
    <div className={cn("mr-3", className)}>
      {active ? (
        <div className="flex items-center gap-x-3">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-success py-1 text-xs font-semibold text-charcoal-900">
            {stepNumber}
          </span>
          <Header2>{title}</Header2>
        </div>
      ) : (
        <div className="flex items-center gap-x-3">
          <span className="flex h-6 w-6 items-center justify-center rounded border border-charcoal-700 bg-charcoal-800 py-1 text-xs font-semibold text-text-dimmed">
            {complete ? <CheckIcon className="size-4" /> : stepNumber}
          </span>

          {displaySpinner ? (
            <div className="flex items-center gap-x-2">
              <Header2>{title}</Header2>
              <Spinner />
            </div>
          ) : (
            <Header2>{title}</Header2>
          )}
        </div>
      )}
    </div>
  );
}
