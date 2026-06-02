import { ArrowUpIcon, StopIcon } from "@heroicons/react/20/solid";
import { useLayoutEffect, useRef, useEffect } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";

interface AIChatInputProps {
  input: string;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
  isLoading: boolean;
  status: string;
  // Changes when the user switches/starts a chat — used to re-focus the input.
  chatId: string;
}

const INDIGO_FUCHSIA = { background: "rgba(99, 102, 241, 1)", foreground: "rgba(217, 70, 239, 1)" };

export function AIChatInput({
  input,
  onInputChange,
  onSubmit,
  onStop,
  isLoading,
  status,
  chatId,
}: AIChatInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus on mount and whenever the active chat changes (e.g. switching via
  // history or starting a new chat) so the user can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, [chatId]);

  // Auto-grow the textarea with its content. A single row collapses to the
  // `min-h-8` (32px = the send-button height) so `items-end` centers them; as
  // content wraps it grows and the button stays pinned to the bottom. The
  // `max-h-[70px]` class caps it at 3 rows, after which it scrolls. scrollHeight
  // excludes the border, so add it back to avoid a phantom scrollbar. Recompute
  // on every value change and on chat switch.
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const styles = getComputedStyle(ta);
    const border = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
    ta.style.height = `${ta.scrollHeight + border}px`;
  }, [input, chatId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  };

  const isStreaming = status === "streaming";
  const isPreparing = status === "submitted";

  return (
    <form onSubmit={onSubmit} className="flex-shrink-0 border-t border-grid-bright p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={onInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question…"
          disabled={isLoading}
          autoFocus
          className="min-h-8 max-h-[70px] flex-1 resize-none overflow-y-auto rounded-md border border-grid-bright bg-background-dimmed px-3 py-1 text-sm leading-5 text-text-bright placeholder:text-text-dimmed scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600 focus-visible:focus-custom disabled:opacity-50"
        />
        {isStreaming ? (
          // Stop button — only the gradient ring spins (a separate absolutely
          // positioned layer), so the stop icon itself stays still.
          <button
            type="button"
            onClick={onStop}
            title="Stop generating"
            className="group relative flex size-8 min-w-8 items-center justify-center overflow-hidden rounded-full"
          >
            <span className="absolute inset-0 animate-spin bg-gradient-to-br from-indigo-500 via-purple-500 to-fuchsia-500 [animation-duration:3s]" />
            <span className="relative z-10 flex size-[calc(100%-2px)] items-center justify-center rounded-full bg-charcoal-600 transition group-hover:bg-charcoal-550">
              <StopIcon className="size-4 text-indigo-500 group-hover:text-indigo-400" />
            </span>
          </button>
        ) : isPreparing ? (
          // Preparing — static gradient ring + spinner, not interactive.
          <div className="size-8 min-w-8 rounded-full bg-gradient-to-br from-indigo-500 via-purple-500 to-fuchsia-500 p-px">
            <div className="flex size-full items-center justify-center rounded-full bg-charcoal-600">
              <Spinner className="size-4" color={INDIGO_FUCHSIA} />
            </div>
          </div>
        ) : (
          <Button
            type="submit"
            disabled={!input.trim()}
            LeadingIcon={<ArrowUpIcon className="size-4 text-text-bright" />}
            variant="primary/small"
            className="size-8 min-w-8 rounded-full"
          />
        )}
      </div>
    </form>
  );
}
