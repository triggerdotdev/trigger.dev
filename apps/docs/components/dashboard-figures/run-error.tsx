// The error panel in the run inspector for a run stopped by its maxDuration: the error code and the
// message in an error callout. Drawn from source (RunError.tsx, Callout.tsx); the webapp files it
// mirrors are its `sources` in lib/dashboard-figures.ts.
import * as I from "./icons";

export function RunErrorFigure() {
  return (
    <div className="h-full bg-background-bright p-3">
      <div className="flex flex-col gap-2">
        <div className="font-sans text-sm leading-5 font-semibold text-rose-500">
          MAX_DURATION_EXCEEDED
        </div>
        <div className="flex w-full items-start gap-2 rounded-md border pl-2 pr-2 shadow-md backdrop-blur-xs py-2.5 border-error/20 bg-error/10">
          <div className="flex w-full items-start gap-2.5">
            <I.ExclamationCircleIcon className="h-5 w-5 shrink-0 text-error" />
            <span>
              {/* A <pre> in the webapp; text-wrap lets it wrap like this. */}
              <span className="block whitespace-pre-wrap text-wrap font-sans text-sm font-normal text-rose-500 dark:text-rose-200 [word-break:break-word]">
                Run exceeded maximum compute time (maxDuration) of 300 seconds
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
