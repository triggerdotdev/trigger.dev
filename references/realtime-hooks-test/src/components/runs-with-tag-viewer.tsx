"use client";

import { useRealtimeRunsWithTag } from "@trigger.dev/react-hooks";
import type { taggedTask } from "@/trigger/tagged-task";

type RunsWithTagViewerProps = {
  tag: string;
  accessToken: string;
};

function StatusDot({ status }: { status: string }) {
  const colors = {
    COMPLETED: "bg-emerald-500",
    EXECUTING: "bg-blue-500 animate-pulse",
    FAILED: "bg-red-500",
    PENDING: "bg-zinc-500",
    QUEUED: "bg-yellow-500",
  };
  const color = colors[status as keyof typeof colors] || colors.PENDING;
  return <div className={`w-2 h-2 rounded-full ${color}`} title={status} />;
}

export function RunsWithTagViewer({ tag, accessToken }: RunsWithTagViewerProps) {
  const { runs, error, stop } = useRealtimeRunsWithTag<typeof taggedTask>([tag], {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    createdAt: "1h",
  });

  if (error) {
    return (
      <div className="rounded-md bg-destructive/15 p-4 text-sm text-destructive border border-destructive/20">
        <div className="font-semibold">Connection Error</div>
        <div>{error.message}</div>
      </div>
    );
  }

  const stats = {
    total: runs.length,
    executing: runs.filter((r) => r.status === "EXECUTING").length,
    completed: runs.filter((r) => r.status === "COMPLETED").length,
    failed: runs.filter((r) => r.status === "FAILED").length,
  };

  return (
    <div className="space-y-6">
      {/* Header & Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-card border border-border p-4 rounded-lg">
          <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
            Total Runs
          </div>
          <div className="text-2xl font-mono font-bold">{stats.total}</div>
        </div>
        <div className="bg-card border border-border p-4 rounded-lg">
          <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1 text-blue-500">
            Executing
          </div>
          <div className="text-2xl font-mono font-bold text-blue-500">{stats.executing}</div>
        </div>
        <div className="bg-card border border-border p-4 rounded-lg">
          <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1 text-emerald-500">
            Completed
          </div>
          <div className="text-2xl font-mono font-bold text-emerald-500">{stats.completed}</div>
        </div>
        <div className="bg-card border border-border p-4 rounded-lg">
          <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1 text-red-500">
            Failed
          </div>
          <div className="text-2xl font-mono font-bold text-red-500">{stats.failed}</div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Watching tag:</span>
          <span className="px-2 py-0.5 bg-secondary text-secondary-foreground rounded font-mono text-xs">
            {tag}
          </span>
        </div>
        <button
          onClick={() => stop()}
          className="px-3 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-md transition-colors"
        >
          Stop Subscription
        </button>
      </div>

      {/* Runs List */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="grid grid-cols-12 gap-4 px-4 py-3 border-b border-border bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <div className="col-span-1 text-center">Status</div>
          <div className="col-span-4">Run ID</div>
          <div className="col-span-3">User / Action</div>
          <div className="col-span-2">Progress</div>
          <div className="col-span-2 text-right">Age</div>
        </div>

        <div className="divide-y divide-border/50 max-h-[600px] overflow-y-auto">
          {runs.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              No runs found with tag "{tag}" in the last hour
            </div>
          ) : (
            runs.map((run) => {
              const progress = (run.metadata as any)?.progress || 0;
              const userId = (run.metadata as any)?.userId || "-";
              const action = (run.metadata as any)?.action || "-";

              return (
                <div
                  key={run.id}
                  className="grid grid-cols-12 gap-4 px-4 py-3 text-sm hover:bg-secondary/20 transition-colors items-center"
                >
                  <div className="col-span-1 flex justify-center">
                    <StatusDot status={run.status} />
                  </div>
                  <div
                    className="col-span-4 font-mono text-xs text-muted-foreground truncate"
                    title={run.id}
                  >
                    {run.id}
                  </div>
                  <div className="col-span-3 truncate text-xs">
                    <span className="text-foreground font-medium">{userId}</span>
                    <span className="text-muted-foreground mx-1">/</span>
                    <span className="text-muted-foreground">{action}</span>
                  </div>
                  <div className="col-span-2">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-500"
                          style={{ width: `${progress * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono w-8 text-right">
                        {Math.round(progress * 100)}%
                      </span>
                    </div>
                  </div>
                  <div className="col-span-2 text-right font-mono text-xs text-muted-foreground">
                    {run.createdAt ? new Date(run.createdAt).toLocaleTimeString() : "-"}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
