import { RunPanel, RunPanelBody, RunPanelHeader } from "./RunCard";

export function TaskCardSkeleton() {
  return (
    <RunPanel>
      <RunPanelHeader
        icon={undefined}
        title={<div className="h-5 w-36 max-w-full rounded border bg-slate-800" />}
      />
      <RunPanelBody>
        <div className="flex w-full flex-col justify-between gap-y-1">
          <div className="flex items-baseline justify-between gap-x-3 pr-3 md:justify-start md:pr-0">
            <div className="h-5 w-1/4 rounded border bg-slate-800" />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div className="h-2.5 w-1/2 rounded border bg-slate-800" />
          </div>
        </div>
      </RunPanelBody>
    </RunPanel>
  );
}
