import { useState } from "react";
import { CodeBlock } from "~/components/code/CodeBlock";
import type { AISpanData, ToolDefinition } from "./types";

export function AIToolsInventory({ aiData }: { aiData: AISpanData }) {
  const defs = aiData.toolDefinitions ?? [];
  const calledNames = getCalledToolNames(aiData);

  if (defs.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-text-dimmed">
        No tool definitions available for this span.
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-grid-bright px-3">
      {defs.map((def) => {
        const wasCalled = calledNames.has(def.name);
        return <ToolDefRow key={def.name} def={def} wasCalled={wasCalled} />;
      })}
    </div>
  );
}

function ToolDefRow({ def, wasCalled }: { def: ToolDefinition; wasCalled: boolean }) {
  const [showSchema, setShowSchema] = useState(false);

  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <div className="flex items-center gap-2">
        <div
          className={`size-1.5 shrink-0 rounded-full ${
            wasCalled ? "bg-success" : "bg-charcoal-600"
          }`}
        />
        <code className="font-mono text-xs text-text-bright">{def.name}</code>
        <span className="text-[10px] text-text-dimmed">{wasCalled ? "called" : "not called"}</span>
      </div>

      {def.description && (
        <p className="pl-3.5 text-xs leading-relaxed text-text-dimmed">{def.description}</p>
      )}

      {def.parametersJson && (
        <div className="pl-3.5">
          <button
            onClick={() => setShowSchema(!showSchema)}
            className="text-[10px] text-text-link hover:underline"
          >
            {showSchema ? "Hide schema" : "Show schema"}
          </button>
          {showSchema && (
            <div className="mt-1">
              <CodeBlock
                code={def.parametersJson}
                maxLines={16}
                showLineNumbers={false}
                showCopyButton
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getCalledToolNames(aiData: AISpanData): Set<string> {
  const names = new Set<string>();
  if (!aiData.items) return names;

  for (const item of aiData.items) {
    if (item.type === "tool-use") {
      for (const tool of item.tools) {
        names.add(tool.toolName);
      }
    }
  }

  return names;
}
