"use client";

import { useRealtimeStream } from "@trigger.dev/react-hooks";
import { textStream } from "@/trigger/streams";
import { useState, useEffect, useRef } from "react";

type StreamViewerProps = {
  runId: string;
  accessToken: string;
};

export function StreamViewer({ runId, accessToken }: StreamViewerProps) {
  const [chunkLog, setChunkLog] = useState<Array<{ chunk: string; timestamp: number }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { parts, error, stop } = useRealtimeStream(textStream, runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    throttleInMs: 50,
    timeoutInSeconds: 120,
    onData: (chunk) => {
      setChunkLog((prev) => [...prev, { chunk, timestamp: Date.now() }]);
    },
  });

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [parts]);

  if (error) {
    return (
      <div className="rounded-md bg-destructive/15 p-4 text-sm text-destructive border border-destructive/20">
        <div className="font-semibold">Connection Error</div>
        <div>{error.message}</div>
      </div>
    );
  }

  const fullText = parts.join("");

  return (
    <div className="space-y-6 h-[calc(100vh-120px)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-card border border-border rounded-lg flex-shrink-0">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Stream Monitor</h2>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono bg-secondary px-1.5 py-0.5 rounded text-secondary-foreground">
              {runId}
            </span>
            <span>•</span>
            <span>{parts.length} chunks</span>
            <span>•</span>
            <span>{fullText.length} chars</span>
          </div>
        </div>
        <button
          onClick={() => stop()}
          className="px-3 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-md transition-colors"
        >
          Stop Stream
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 min-h-0">
        {/* Main Output Console */}
        <div className="bg-card border border-border rounded-lg flex flex-col overflow-hidden shadow-inner bg-[#0d0d0d]">
          <div className="px-4 py-2 border-b border-border bg-secondary/20 text-xs font-mono text-muted-foreground flex justify-between">
            <span>OUTPUT</span>
            <span>UTF-8</span>
          </div>
          <div
            ref={scrollRef}
            className="flex-1 p-4 overflow-y-auto font-mono text-sm whitespace-pre-wrap text-foreground/90 leading-relaxed"
          >
            {fullText || (
              <span className="text-muted-foreground/50 italic">Waiting for stream output...</span>
            )}
            {/* Cursor blink effect */}
            <span className="inline-block w-2 h-4 ml-1 align-middle bg-primary animate-pulse"></span>
          </div>
        </div>

        {/* Chunk Log Table */}
        <div className="bg-card border border-border rounded-lg flex flex-col overflow-hidden">
          <div className="px-4 py-2 border-b border-border bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Packet Log
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-xs font-mono">
              <thead className="bg-secondary/10 text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-4 py-2 text-left font-medium w-24">Time</th>
                  <th className="px-4 py-2 text-left font-medium">Chunk Preview</th>
                  <th className="px-4 py-2 text-right font-medium w-16">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {chunkLog.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground italic">
                      No packets received
                    </td>
                  </tr>
                ) : (
                  chunkLog.map((log, i) => (
                    <tr key={i} className="hover:bg-secondary/20 transition-colors">
                      <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                        {new Date(log.timestamp).toLocaleTimeString().split(" ")[0]}.
                        <span className="text-muted-foreground/60">
                          {String(log.timestamp % 1000).padStart(3, "0")}
                        </span>
                      </td>
                      <td
                        className="px-4 py-2 text-primary/80 truncate max-w-[200px]"
                        title={log.chunk}
                      >
                        {log.chunk.replace(/\n/g, "↵")}
                      </td>
                      <td className="px-4 py-2 text-right text-muted-foreground">
                        {log.chunk.length}B
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
