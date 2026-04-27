import { Header3 } from "~/components/primitives/Headers";
import { CodeBlock } from "~/components/code/CodeBlock";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { formatDuration, tryPrettyJson } from "./aiHelpers";
import { SpanMetricRow as MetricRow } from "./SpanMetricRow";

export type AIToolCallData = {
  toolName: string;
  toolCallId: string;
  args?: string;
  durationMs: number;
};

export function extractAIToolCallData(
  properties: Record<string, unknown>,
  durationMs: number
): AIToolCallData | undefined {
  const ai = properties.ai;
  if (!ai || typeof ai !== "object") return undefined;

  const a = ai as Record<string, unknown>;
  if (a.operationId !== "ai.toolCall") return undefined;

  const toolCall = a.toolCall;
  if (!toolCall || typeof toolCall !== "object") return undefined;

  const tc = toolCall as Record<string, unknown>;
  const toolName = typeof tc.name === "string" ? tc.name : undefined;
  if (!toolName) return undefined;

  return {
    toolName,
    toolCallId: typeof tc.id === "string" ? tc.id : "",
    args: typeof tc.args === "string" ? tc.args : undefined,
    durationMs,
  };
}

export function AIToolCallSpanDetails({ data }: { data: AIToolCallData }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="flex flex-col px-3">
          {/* Tool info */}
          <div className="flex flex-col gap-1 py-2.5">
            <div className="flex flex-col text-xs @container">
              <MetricRow label="Tool" value={data.toolName} />
              {data.toolCallId && (
                <MetricRow
                  label="Call ID"
                  value={<TruncatedCopyableValue value={data.toolCallId} />}
                />
              )}
              <MetricRow label="Duration" value={formatDuration(data.durationMs)} />
            </div>
          </div>

          {/* Input args */}
          {data.args && (
            <div className="flex flex-col gap-1.5 py-2.5">
              <Header3>Input</Header3>
              <CodeBlock
                code={tryPrettyJson(data.args)}
                maxLines={20}
                showLineNumbers={false}
                showCopyButton
                language="json"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

