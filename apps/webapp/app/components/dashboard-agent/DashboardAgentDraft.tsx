import { useCallback, useState } from "react";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentSuggestedPrompts } from "./DashboardAgentSuggestedPrompts";

/**
 * The new-chat "draft" state: suggested prompts + composer with no transport
 * mounted and no chat id yet. The chat id is server-owned, so the first send
 * goes to the panel's `create` call, which generates the id and returns it;
 * only then does the real `DashboardAgentChat` mount. The client never invents
 * a chat id.
 */
export function DashboardAgentDraft({
  onSubmit,
  projectSlug,
  environmentSlug,
  currentPage,
}: {
  onSubmit: (text: string) => void;
  projectSlug: string;
  environmentSlug: string;
  currentPage: string;
}) {
  const [input, setInput] = useState("");

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setInput("");
      onSubmit(trimmed);
    },
    [onSubmit]
  );

  return (
    <>
      <DashboardAgentContextBanner
        projectSlug={projectSlug}
        environmentSlug={environmentSlug}
        currentPage={currentPage}
      />
      <DashboardAgentSuggestedPrompts onSelect={submit} />
      <DashboardAgentComposer
        value={input}
        onChange={setInput}
        onSubmit={() => submit(input)}
        onStop={() => {}}
        isStreaming={false}
      />
    </>
  );
}
