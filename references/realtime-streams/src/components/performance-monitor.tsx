"use client";

import { demoStream } from "@/app/streams";
import type { PerformanceChunk } from "@/trigger/streams";
import { useRealtimeStream } from "@trigger.dev/react-hooks";
import { useEffect, useMemo, useRef, useState } from "react";

type ChunkLatency = {
  chunkIndex: number;
  sentAt: number;
  receivedAt: number;
  latency: number;
  data: string;
};

export function PerformanceMonitor({ accessToken, runId }: { accessToken: string; runId: string }) {
  const { parts, error } = useRealtimeStream(demoStream, runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  const [firstChunkTime, setFirstChunkTime] = useState<number | null>(null);
  const [startTime] = useState<number>(Date.now());
  const [chunkLatencies, setChunkLatencies] = useState<ChunkLatency[]>([]);
  const processedCountRef = useRef<number>(0);

  // Process new chunks only (append-only pattern)
  useEffect(() => {
    if (!parts || parts.length === 0) return;

    // Only process chunks we haven't seen yet
    const newChunks = parts.slice(processedCountRef.current);
    if (newChunks.length === 0) return;

    const now = Date.now();
    const newLatencies: ChunkLatency[] = [];

    for (const rawChunk of newChunks) {
      try {
        const chunk: PerformanceChunk = JSON.parse(rawChunk);

        if (chunkLatencies.length === 0 && firstChunkTime === null) {
          setFirstChunkTime(now);
        }

        newLatencies.push({
          chunkIndex: chunk.chunkIndex,
          sentAt: chunk.timestamp,
          receivedAt: now,
          latency: now - chunk.timestamp,
          data: chunk.data,
        });
      } catch (e) {
        // Skip non-JSON chunks
        console.error("Failed to parse chunk:", rawChunk, e);
      }
    }

    if (newLatencies.length > 0) {
      setChunkLatencies((prev) => [...prev, ...newLatencies]);
      processedCountRef.current = parts.length;
    }
  }, [parts, chunkLatencies.length, firstChunkTime]);

  // Calculate statistics
  const stats = useMemo(() => {
    if (chunkLatencies.length === 0) {
      return {
        count: 0,
        avgLatency: 0,
        minLatency: 0,
        maxLatency: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        timeToFirstChunk: null,
      };
    }

    // Create sorted copy for percentile calculations
    const sortedLatencies = [...chunkLatencies.map((c) => c.latency)].sort((a, b) => a - b);
    const sum = sortedLatencies.reduce((acc, val) => acc + val, 0);

    // Correct percentile calculation
    const percentile = (p: number) => {
      if (sortedLatencies.length === 0) return 0;

      // Use standard percentile formula: position = (p/100) * (n-1)
      const position = (p / 100) * (sortedLatencies.length - 1);
      const lower = Math.floor(position);
      const upper = Math.ceil(position);

      // Interpolate between values if needed
      if (lower === upper) {
        return sortedLatencies[lower];
      }

      const weight = position - lower;
      return sortedLatencies[lower] * (1 - weight) + sortedLatencies[upper] * weight;
    };

    return {
      count: chunkLatencies.length,
      avgLatency: sum / sortedLatencies.length,
      minLatency: sortedLatencies[0] || 0,
      maxLatency: sortedLatencies[sortedLatencies.length - 1] || 0,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
      timeToFirstChunk: firstChunkTime ? firstChunkTime - startTime : null,
    };
  }, [chunkLatencies, firstChunkTime, startTime]);

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <p className="text-red-600 font-semibold">Error: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard label="Chunks Received" value={stats.count.toString()} suffix="chunks" />
        <MetricCard label="Avg Latency" value={stats.avgLatency.toFixed(0)} suffix="ms" highlight />
        <MetricCard label="P95 Latency" value={stats.p95.toFixed(0)} suffix="ms" />
        <MetricCard label="P99 Latency" value={stats.p99.toFixed(0)} suffix="ms" />
      </div>

      {/* Additional Stats */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Detailed Statistics</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
          <StatItem
            label="Time to First Chunk"
            value={
              stats.timeToFirstChunk !== null
                ? `${stats.timeToFirstChunk.toFixed(0)} ms`
                : "Waiting..."
            }
          />
          <StatItem label="Min Latency" value={`${stats.minLatency.toFixed(0)} ms`} />
          <StatItem label="Max Latency" value={`${stats.maxLatency.toFixed(0)} ms`} />
          <StatItem label="P50 (Median)" value={`${stats.p50.toFixed(0)} ms`} />
          <StatItem label="Total Chunks" value={stats.count.toString()} />
        </div>
      </div>

      {/* All Chunks Table */}
      {chunkLatencies.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            All Chunks ({chunkLatencies.length} total)
          </h3>
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Index
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Data
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Latency
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Sent At
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {chunkLatencies.map((chunk, index) => (
                  <tr key={`${chunk.chunkIndex}-${index}`} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900">#{chunk.chunkIndex}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{chunk.data}</td>
                    <td className="px-4 py-3 text-sm text-right">
                      <span
                        className={`inline-block px-2 py-1 rounded text-xs font-semibold ${
                          chunk.latency > stats.p95
                            ? "bg-red-100 text-red-800"
                            : chunk.latency > stats.p50
                            ? "bg-yellow-100 text-yellow-800"
                            : "bg-green-100 text-green-800"
                        }`}
                      >
                        {chunk.latency.toFixed(0)} ms
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 text-right">
                      {new Date(chunk.sentAt).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  suffix,
  highlight = false,
}: {
  label: string;
  value: string;
  suffix: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg shadow p-4 ${
        highlight ? "bg-blue-50 border-2 border-blue-200" : "bg-white"
      }`}
    >
      <p className="text-xs font-medium text-gray-600 uppercase mb-1">{label}</p>
      <p className={`text-2xl font-bold ${highlight ? "text-blue-900" : "text-gray-900"}`}>
        {value}
      </p>
      <p className="text-xs text-gray-500 mt-1">{suffix}</p>
    </div>
  );
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm text-gray-600">{label}</p>
      <p className="text-lg font-semibold text-gray-900 mt-1">{value}</p>
    </div>
  );
}
