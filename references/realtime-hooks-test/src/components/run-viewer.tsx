"use client";

import { useRealtimeRun } from "@trigger.dev/react-hooks";
import type { simpleTask } from "@/trigger/simple-task";
import { useState } from "react";

type RunViewerProps = {
  runId: string;
  accessToken: string;
};

function StatusBadge({ status }: { status: string }) {
  const colors = {
    COMPLETED: "bg-emerald-500/15 text-emerald-500 border-emerald-500/20",
    EXECUTING: "bg-blue-500/15 text-blue-500 border-blue-500/20",
    FAILED: "bg-red-500/15 text-red-500 border-red-500/20",
    PENDING: "bg-zinc-500/15 text-zinc-500 border-zinc-500/20",
    QUEUED: "bg-yellow-500/15 text-yellow-500 border-yellow-500/20",
  };
  
  const colorClass = colors[status as keyof typeof colors] || colors.PENDING;
  
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${colorClass}`}>
      {status}
    </span>
  );
}

function CodeBlock({ label, data }: { label: string, data: any }) {
  if (!data) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
      <pre className="bg-secondary/50 border border-border rounded-md p-3 text-xs overflow-x-auto font-mono text-foreground/90">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

export function RunViewer({ runId, accessToken }: RunViewerProps) {
  const [stopOnCompletion, setStopOnCompletion] = useState(true);

  const { run, error, stop } = useRealtimeRun<typeof simpleTask>(runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    stopOnCompletion,
  });

  if (error) {
    return (
      <div className="rounded-md bg-destructive/15 p-4 text-sm text-destructive border border-destructive/20">
        <div className="font-semibold">Connection Error</div>
        <div>{error.message}</div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-secondary rounded w-1/3"></div>
        <div className="h-32 bg-secondary rounded"></div>
      </div>
    );
  }

  const progress = (run.metadata as any)?.progress || 0;
  const currentStep = (run.metadata as any)?.currentStep || 0;
  const totalSteps = (run.metadata as any)?.totalSteps || 0;

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex items-center justify-between p-4 bg-card border border-border rounded-lg">
        <div className="flex items-center gap-4">
          <StatusBadge status={run.status} />
          <div className="font-mono text-sm text-muted-foreground">{run.id}</div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
            <input
              type="checkbox"
              checked={stopOnCompletion}
              onChange={(e) => setStopOnCompletion(e.target.checked)}
              className="rounded border-input bg-background text-primary focus:ring-ring"
            />
            <span>Stop on completion</span>
          </label>
          <button
            onClick={() => stop()}
            className="px-3 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-md transition-colors"
          >
            Disconnect
          </button>
        </div>
      </div>

      {/* Progress Section */}
      <div className="bg-card border border-border rounded-lg p-6 space-y-4">
        <div className="flex justify-between items-end">
          <div>
            <h3 className="text-lg font-semibold">Task Progress</h3>
            <p className="text-sm text-muted-foreground">
              Step {currentStep} of {totalSteps}
            </p>
          </div>
          <div className="text-2xl font-mono font-bold text-primary">
            {Math.round(progress * 100)}%
          </div>
        </div>
        <div className="h-2 bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-500 ease-out"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      {/* Data Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
          <h3 className="font-semibold">Metadata</h3>
          <div className="space-y-3">
            {Object.entries(run.metadata || {}).map(([key, value]) => (
              <div key={key} className="flex justify-between items-center py-2 border-b border-border/50 last:border-0">
                <span className="text-sm text-muted-foreground font-mono">{key}</span>
                <span className="text-sm font-medium font-mono">
                   {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          <CodeBlock label="Payload" data={run.payload} />
          <CodeBlock label="Output" data={run.output} />
          {run.error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 p-4">
               <p className="text-sm font-medium text-destructive mb-2">Error: {run.error.name}</p>
               <p className="text-sm text-destructive/90 font-mono whitespace-pre-wrap">{run.error.message}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
