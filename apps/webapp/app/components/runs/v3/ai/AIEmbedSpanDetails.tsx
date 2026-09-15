import type { SpanEvent as OtelSpanEvent } from "@trigger.dev/core/v3";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SpanEvents } from "~/components/runs/v3/SpanEvents";
import { formatDuration } from "./aiHelpers";
import { SpanMetricRow as MetricRow } from "./SpanMetricRow";

export type AIEmbedData = {
  model: string;
  provider: string;
  value?: string;
  durationMs: number;
};

export function extractAIEmbedData(
  properties: Record<string, unknown>,
  durationMs: number
): AIEmbedData | undefined {
  const ai = properties.ai;
  if (!ai || typeof ai !== "object") return undefined;

  const a = ai as Record<string, unknown>;
  if (a.operationId !== "ai.embed") return undefined;

  const aiModel = a.model;
  if (!aiModel || typeof aiModel !== "object") return undefined;

  const m = aiModel as Record<string, unknown>;
  const model = typeof m.id === "string" ? m.id : undefined;
  if (!model) return undefined;

  return {
    model,
    provider: typeof m.provider === "string" ? m.provider : "unknown",
    value: typeof a.value === "string" ? a.value : undefined,
    durationMs,
  };
}

export function AIEmbedSpanDetails({
  data,
  spanEvents,
}: {
  data: AIEmbedData;
  spanEvents?: OtelSpanEvent[];
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        <div className="flex flex-col px-3">
          {/* Model info */}
          <div className="flex flex-col gap-1 py-2.5">
            <div className="flex flex-col text-xs @container">
              <MetricRow label="Model" value={data.model} />
              <MetricRow label="Provider" value={data.provider} />
              <MetricRow label="Duration" value={formatDuration(data.durationMs)} />
            </div>
          </div>

          {/* Input value */}
          {data.value && (
            <div className="flex flex-col gap-1.5 py-2.5">
              <Header3>Input</Header3>
              <div className="rounded-md border border-grid-bright bg-background-hover/50 px-3.5 py-2">
                <Paragraph variant="small/dimmed">{data.value}</Paragraph>
              </div>
            </div>
          )}

          {spanEvents && spanEvents.some((event) => !event.name.startsWith("trigger.dev/")) && (
            <div className="py-2.5">
              <SpanEvents spanEvents={spanEvents} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
