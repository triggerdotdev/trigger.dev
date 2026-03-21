import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";

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

export function AIEmbedSpanDetails({ data }: { data: AIEmbedData }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
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
              <div className="rounded-md border border-grid-bright bg-charcoal-750/50 px-3.5 py-2">
                <Paragraph variant="small/dimmed">{data.value}</Paragraph>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid h-7 grid-cols-[1fr_auto] items-center gap-4 rounded-sm px-1.5 transition odd:bg-charcoal-750/40 @[28rem]:grid-cols-[8rem_1fr] hover:bg-white/[0.04]">
      <span className="text-text-dimmed">{label}</span>
      <span className="text-right text-text-bright @[28rem]:text-left">{value}</span>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}
