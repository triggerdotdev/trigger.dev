export function TutorialStep({
  stepNumber,
  drawLine,
  active = false,
  complete = false,
}: {
  stepNumber?: string;
  drawLine?: boolean;
  active?: boolean;
  complete?: boolean;
}) {
  return (
    <div className="mr-3 flex flex-col items-center justify-center">
      {active ? (
        <span className="flex h-7 w-7 items-center justify-center rounded bg-green-600 py-1 text-sm font-semibold text-slate-900 shadow">
          {stepNumber}
        </span>
      ) : (
        <span className="flex h-7 w-7 items-center justify-center rounded border border-slate-700 bg-slate-800 py-1 text-sm font-semibold text-green-400 shadow">
          {complete ? "✓" : stepNumber}
        </span>
      )}

      {drawLine ? (
        <div className="h-full border-l border-slate-700"></div>
      ) : (
        <div className="h-full"></div>
      )}
    </div>
  );
}
