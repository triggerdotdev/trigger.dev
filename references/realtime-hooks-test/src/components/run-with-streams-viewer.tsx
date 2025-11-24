"use client";

import { useRealtimeRunWithStreams } from "@trigger.dev/react-hooks";
import type { streamTask } from "@/trigger/stream-task";
import { useState } from "react";

type StreamResults = {
  text: string[];
  data: Array<{ step: number; data: string; timestamp: number }>;
};

type RunWithStreamsViewerProps = {
  runId: string;
  accessToken: string;
};

export function RunWithStreamsViewer({ runId, accessToken }: RunWithStreamsViewerProps) {
  const { run, streams, error, stop } = useRealtimeRunWithStreams<
    typeof streamTask,
    StreamResults
  >(runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    throttleInMs: 50,
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
        <div className="grid grid-cols-2 gap-4">
           <div className="h-64 bg-secondary rounded"></div>
           <div className="h-64 bg-secondary rounded"></div>
        </div>
      </div>
    );
  }

  const textStream = streams.text || [];
  const dataStream = streams.data || [];

  return (
    <div className="space-y-6 h-[calc(100vh-120px)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-card border border-border rounded-lg flex-shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">Status</span>
            <span className={`font-mono text-sm font-medium ${
              run.status === 'COMPLETED' ? 'text-emerald-500' : 
              run.status === 'EXECUTING' ? 'text-blue-500' : 'text-zinc-500'
            }`}>
              {run.status}
            </span>
          </div>
          <div className="w-px h-8 bg-border"></div>
          <div className="flex flex-col">
             <span className="text-xs text-muted-foreground uppercase tracking-wider">Run ID</span>
             <span className="font-mono text-sm">{run.id}</span>
          </div>
        </div>
        <button
          onClick={() => stop()}
          className="px-3 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-md transition-colors"
        >
          Stop Subscription
        </button>
      </div>

      {/* Streams Split View */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0">
        {/* Text Stream Panel */}
        <div className="bg-card border border-border rounded-lg flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-secondary/30 flex justify-between items-center">
            <h3 className="font-medium text-sm flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500"></span>
              Text Stream
            </h3>
            <span className="text-xs text-muted-foreground font-mono">{textStream.length} chunks</span>
          </div>
          <div className="flex-1 p-4 overflow-y-auto bg-background/50 font-mono text-sm whitespace-pre-wrap">
            {textStream.join("") || <span className="text-muted-foreground italic">Waiting for data...</span>}
          </div>
        </div>

        {/* Data Stream Panel */}
        <div className="bg-card border border-border rounded-lg flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-secondary/30 flex justify-between items-center">
            <h3 className="font-medium text-sm flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-purple-500"></span>
              Data Stream
            </h3>
            <span className="text-xs text-muted-foreground font-mono">{dataStream.length} items</span>
          </div>
          <div className="flex-1 p-0 overflow-y-auto bg-background/50">
            <div className="divide-y divide-border/50">
              {dataStream.length === 0 && (
                <div className="p-4 text-muted-foreground italic text-sm">Waiting for data...</div>
              )}
              {dataStream.map((item, index) => (
                <div key={index} className="p-3 hover:bg-secondary/30 transition-colors font-mono text-xs">
                  <div className="flex justify-between text-muted-foreground mb-1">
                    <span>Step {item.step}</span>
                    <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-foreground">{item.data}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      
      {run.output && (
        <div className="bg-card border border-border rounded-lg p-4 flex-shrink-0">
          <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Task Output</div>
          <pre className="text-xs font-mono overflow-x-auto">
            {JSON.stringify(run.output, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
