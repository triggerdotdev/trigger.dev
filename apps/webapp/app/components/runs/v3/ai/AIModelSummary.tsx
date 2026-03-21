import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import { Header3 } from "~/components/primitives/Headers";
import type { AISpanData } from "./types";

export function AITagsRow({ aiData }: { aiData: AISpanData }) {
  return (
    <div className="flex flex-col gap-1 py-2.5">
      <div className="flex flex-col text-xs @container">
        <MetricRow label="Model" value={aiData.model} />
        {aiData.provider !== "unknown" && <MetricRow label="Provider" value={aiData.provider} />}
        {aiData.resolvedProvider && (
          <MetricRow label="Resolved provider" value={aiData.resolvedProvider} />
        )}
        {aiData.finishReason && <MetricRow label="Finish reason" value={aiData.finishReason} />}
        {aiData.serviceTier && <MetricRow label="Service tier" value={aiData.serviceTier} />}
        {aiData.toolChoice && <MetricRow label="Tool choice" value={aiData.toolChoice} />}
        {aiData.toolCount != null && aiData.toolCount > 0 && (
          <MetricRow
            label="Tools provided"
            value={`${aiData.toolCount} ${aiData.toolCount === 1 ? "tool" : "tools"}`}
          />
        )}
        {aiData.messageCount != null && (
          <MetricRow
            label="Messages"
            value={`${aiData.messageCount} ${aiData.messageCount === 1 ? "message" : "messages"}`}
          />
        )}
        {aiData.telemetryMetadata &&
          Object.entries(aiData.telemetryMetadata).map(([key, value]) => (
            <MetricRow key={key} label={key} value={value} />
          ))}
      </div>
    </div>
  );
}

export function AIStatsSummary({ aiData }: { aiData: AISpanData }) {
  return (
    <div className="flex flex-col gap-1 py-2.5">
      <Header3>Stats</Header3>
      <div className="flex flex-col text-xs @container">
        <MetricRow label="Input" value={aiData.inputTokens.toLocaleString()} unit="tokens" />
        <MetricRow label="Output" value={aiData.outputTokens.toLocaleString()} unit="tokens" />
        {aiData.cachedTokens != null && aiData.cachedTokens > 0 && (
          <MetricRow
            label="Cache read"
            value={aiData.cachedTokens.toLocaleString()}
            unit="tokens"
          />
        )}
        {aiData.cacheCreationTokens != null && aiData.cacheCreationTokens > 0 && (
          <MetricRow
            label="Cache write"
            value={aiData.cacheCreationTokens.toLocaleString()}
            unit="tokens"
          />
        )}
        {aiData.reasoningTokens != null && aiData.reasoningTokens > 0 && (
          <MetricRow
            label="Reasoning"
            value={aiData.reasoningTokens.toLocaleString()}
            unit="tokens"
          />
        )}
        <MetricRow label="Total" value={aiData.totalTokens.toLocaleString()} unit="tokens" bold />

        {aiData.totalCost != null && (
          <MetricRow label="Cost" value={formatCurrencyAccurate(aiData.totalCost)} />
        )}
        {aiData.msToFirstChunk != null && (
          <MetricRow label="TTFC" value={formatTtfc(aiData.msToFirstChunk)} />
        )}
        {aiData.tokensPerSecond != null && (
          <MetricRow label="Speed" value={`${Math.round(aiData.tokensPerSecond)} tok/s`} />
        )}
      </div>
    </div>
  );
}

function MetricRow({
  label,
  value,
  unit,
  bold,
}: {
  label: string;
  value: string;
  unit?: string;
  bold?: boolean;
}) {
  return (
    <div className="grid h-7 grid-cols-[1fr_auto] items-center gap-4 rounded-sm px-1.5 transition odd:bg-charcoal-750/40 @[28rem]:grid-cols-[8rem_1fr] hover:bg-white/[0.04]">
      <span className="text-text-dimmed">{label}</span>
      <span
        className={`text-right @[28rem]:text-left ${
          bold ? "font-medium text-text-bright" : "text-text-bright"
        }`}
      >
        {value}
        {unit && <span className="ml-1 text-text-dimmed">{unit}</span>}
      </span>
    </div>
  );
}

function formatTtfc(ms: number): string {
  if (ms >= 10_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}
