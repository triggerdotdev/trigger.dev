export function JobSkeleton() {
  return (
    <div className={"flex w-full gap-x-4 bg-slate-950 p-4 pr-5 "}>
      <div className="aspect-square h-6 w-6 rounded border border-slate-800 bg-slate-900 p-1.5 md:h-10 md:w-10 lg:h-12 lg:w-12" />
      <div className="flex w-full">
        <div className="flex w-full flex-col justify-between gap-y-1">
          <div className="flex items-baseline justify-between gap-x-3 pr-3 md:justify-start md:pr-0">
            <div className="h-5 w-1/4 rounded border border-slate-800 bg-slate-900" />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div className="h-2.5 w-1/2 rounded border border-slate-800 bg-slate-900" />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <div className="h-1 w-1/5 rounded border border-slate-800 bg-slate-900" />
          </div>
        </div>
      </div>
    </div>
  );
}
