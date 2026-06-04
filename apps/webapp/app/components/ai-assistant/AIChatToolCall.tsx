import { Spinner } from "~/components/primitives/Spinner";

const TOOL_LABELS: Record<string, string> = {
  askExpert: "Consulting the expert…",
  searchDocs: "Searching documentation…",
  navigateToPage: "Finding page…",
  getCurrentContext: "Checking context…",
  searchPages: "Searching pages…",
};

interface AIChatToolCallProps {
  toolName: string;
  state: string;
}

export function AIChatToolCall({ toolName, state }: AIChatToolCallProps) {
  const label = TOOL_LABELS[toolName] ?? `Running ${toolName}…`;
  const isRunning = state === "input-streaming" || state === "input-available";

  if (!isRunning) return null;

  return (
    <div className="flex items-center gap-2 py-2 text-xs text-text-dimmed">
      <Spinner
        className="size-3.5"
        color={{ background: "rgba(99, 102, 241, 1)", foreground: "rgba(217, 70, 239, 1)" }}
      />
      <span>{label}</span>
    </div>
  );
}