import { ArrowUpIcon, StopIcon } from "@heroicons/react/20/solid";
import { useRef, useEffect } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";

interface AIChatInputProps {
  input: string;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
  isLoading: boolean;
  status: string;
}

export function AIChatInput({
  input,
  onInputChange,
  onSubmit,
  onStop,
  isLoading,
  status,
}: AIChatInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isStreaming = status === "streaming";
  const isPreparing = status === "submitted";

  return (
    <form onSubmit={onSubmit} className="flex-shrink-0 border-t border-grid-bright p-3">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={onInputChange}
          placeholder="Ask a question…"
          disabled={isStreaming}
          autoFocus
          className="flex-1 rounded-md border border-grid-bright bg-background-dimmed px-3 py-2 text-sm text-text-bright placeholder:text-text-dimmed focus-visible:focus-custom disabled:opacity-50"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            className="group flex size-9 min-w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 via-purple-500 to-fuchsia-500 p-px"
          >
            <div className="flex size-full items-center justify-center rounded-full bg-charcoal-600 transition group-hover:bg-charcoal-550">
              <StopIcon className="size-4 text-indigo-500" />
            </div>
          </button>
        ) : isPreparing ? (
          <div className="flex size-9 min-w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 via-purple-500 to-fuchsia-500 p-px">
            <div className="flex size-full items-center justify-center rounded-full bg-charcoal-600">
              <Spinner className="size-4" />
            </div>
          </div>
        ) : (
          <Button
            type="submit"
            disabled={!input.trim()}
            LeadingIcon={<ArrowUpIcon className="size-4 text-text-bright" />}
            variant="primary/small"
            className="size-9 min-w-9 rounded-full"
          />
        )}
      </div>
    </form>
  );
}