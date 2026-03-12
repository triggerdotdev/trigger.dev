import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import type { AISpanData } from "./types";

export function AITagsRow({ aiData }: { aiData: AISpanData }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 py-2.5">
      <Pill>{aiData.model}</Pill>
      {aiData.provider !== "unknown" && <Pill variant="dimmed">{aiData.provider}</Pill>}
      {aiData.finishReason && <Pill variant="dimmed">{aiData.finishReason}</Pill>}
      {aiData.serviceTier && <Pill variant="dimmed">tier: {aiData.serviceTier}</Pill>}
      {aiData.toolChoice && <Pill variant="dimmed">tools: {aiData.toolChoice}</Pill>}
      {aiData.toolCount != null && aiData.toolCount > 0 && (
        <Pill variant="dimmed">
          {aiData.toolCount} {aiData.toolCount === 1 ? "tool" : "tools"}
        </Pill>
      )}
      {aiData.messageCount != null && (
        <Pill variant="dimmed">
          {aiData.messageCount} {aiData.messageCount === 1 ? "msg" : "msgs"}
        </Pill>
      )}
      {aiData.telemetryMetadata &&
        Object.entries(aiData.telemetryMetadata).map(([key, value]) => (
          <Pill key={key} variant="dimmed">
            {key}: {value}
          </Pill>
        ))}
    </div>
  );
}

export function AIStatsSummary({ aiData }: { aiData: AISpanData }) {
  return (
    <div className="flex flex-col gap-1 py-2.5">
      <span className="text-xs font-medium uppercase tracking-wide text-text-dimmed">Stats</span>

      <div className="flex flex-col text-[11px]">
        <MetricRow label="Input" value={aiData.inputTokens.toLocaleString()} unit="tokens" />
        <MetricRow label="Output" value={aiData.outputTokens.toLocaleString()} unit="tokens" />
        {aiData.cachedTokens != null && aiData.cachedTokens > 0 && (
          <MetricRow label="Cached" value={aiData.cachedTokens.toLocaleString()} unit="tokens" />
        )}
        {aiData.reasoningTokens != null && aiData.reasoningTokens > 0 && (
          <MetricRow
            label="Reasoning"
            value={aiData.reasoningTokens.toLocaleString()}
            unit="tokens"
          />
        )}
        <MetricRow
          label="Total"
          value={aiData.totalTokens.toLocaleString()}
          unit="tokens"
          bold
          border
        />

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
  border,
}: {
  label: string;
  value: string;
  unit?: string;
  bold?: boolean;
  border?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between py-1 ${
        border ? "border-t border-grid-dimmed" : ""
      }`}
    >
      <span className="text-text-dimmed">{label}</span>
      <span className={bold ? "font-medium text-text-bright" : "text-text-bright"}>
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

function Pill({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "dimmed";
}) {
  return (
    <span
      className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${
        variant === "dimmed"
          ? "bg-charcoal-750 text-text-dimmed"
          : "bg-charcoal-700 text-text-bright"
      }`}
    >
      {children}
    </span>
  );
}
