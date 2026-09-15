/**
 * The chat-history trigger shows the chat's title and opens the history menu, so its accessible
 * name has to carry both: speech-input users activate a control by the words they can see, and a
 * bare "Chat history" hides them (WCAG 2.5.3). The title leads, because that is what is read.
 */
export function chatHistoryTriggerLabel(title: string): string {
  const trimmed = title.trim();
  return trimmed ? `${trimmed}, chat history` : "Chat history";
}
