"use client";

import { useRealtimeBatch } from "@trigger.dev/react-hooks";
import type { batchItemTask } from "@/trigger/batch-task";

type BatchViewerProps = {
  batchId: string;
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

export function BatchViewer({ batchId, accessToken }: BatchViewerProps) {
  const { runs, error, stop } = useRealtimeBatch<typeof batchItemTask>(batchId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  if (error) {
    return (
      <div className="rounded-md bg-destructive/15 p-4 text-sm text-destructive border border-destructive/20">
        <div className="font-semibold">Connection Error</div>
        <div>{error.message}</div>
      </div>
    );
  }

  const totalRuns = runs.length;
  const completedRuns = runs.filter((r) => r.status === "COMPLETED").length;
  const batchProgress = totalRuns > 0 ? completedRuns / totalRuns : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-card border border-border rounded-lg p-6 space-y-6">
        <div className="flex justify-between items-start">
           <div>
             <h2 className="text-lg font-semibold mb-1">Batch Progress</h2>
             <p className="text-sm text-muted-foreground font-mono">{batchId}</p>
           </div>
           <button
            onClick={() => stop()}
            className="px-3 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-md transition-colors"
            >
            Stop Subscription
            </button>
        </div>

        <div className="space-y-2">
           <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Completion</span>
              <span className="font-mono font-medium">{completedRuns} / {totalRuns}</span>
           </div>
           <div className="h-2 bg-secondary rounded-full overflow-hidden">
              <div 
                className="h-full bg-primary transition-all duration-300 ease-out"
                style={{ width: `${batchProgress * 100}%` }}
              />
           </div>
        </div>
      </div>

      {/* Runs Grid */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
         <div className="px-4 py-3 border-b border-border bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider flex justify-between items-center">
            <span>Items</span>
            <span className="font-mono">{runs.length} Tasks</span>
         </div>
         <div className="divide-y divide-border/50 max-h-[600px] overflow-y-auto">
            {runs.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm">
                  Waiting for batch runs...
                </div>
            ) : (
                runs.map((run) => {
                    const progress = (run.metadata as any)?.progress || 0;
                    const itemId = (run.metadata as any)?.itemId || "Item";
                    const inputValue = (run.metadata as any)?.inputValue;
                    const result = (run.output as any)?.result;

                    return (
                        <div key={run.id} className="p-4 hover:bg-secondary/20 transition-colors grid grid-cols-12 gap-4 items-center">
                            <div className="col-span-1 flex justify-center">
                                <StatusDot status={run.status} />
                            </div>
                            <div className="col-span-3">
                                <div className="font-medium text-sm">{itemId}</div>
                                <div className="text-xs text-muted-foreground font-mono">{run.id.slice(-8)}</div>
                            </div>
                            <div className="col-span-4">
                                <div className="flex items-center gap-2">
                                    <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                                        <div 
                                            className={`h-full rounded-full transition-all duration-300 ${run.status === 'FAILED' ? 'bg-destructive' : 'bg-primary'}`}
                                            style={{ width: `${(run.status === 'COMPLETED' ? 1 : progress) * 100}%` }}
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className="col-span-4 text-right font-mono text-sm">
                                {result !== undefined ? (
                                    <span className="text-emerald-500">Result: {result}</span>
                                ) : (
                                    <span className="text-muted-foreground">Input: {inputValue}</span>
                                )}
                            </div>
                        </div>
                    )
                })
            )}
         </div>
      </div>
    </div>
  );
}
