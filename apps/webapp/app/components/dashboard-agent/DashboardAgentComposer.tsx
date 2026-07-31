import { ArrowUpIcon, StopIcon } from "@heroicons/react/20/solid";
import { useEffect, useRef } from "react";
import { Button } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";

export function DashboardAgentComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  focusKey,
  context,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  // Bump to move focus back to the textarea — e.g. text was just prefilled from
  // outside the panel. Focus also happens on mount (panel open, chat switch).
  focusKey?: string | number;
  // The context chip. It describes the message about to be sent, so it belongs
  // in the composer's footer rather than at the top of the panel.
  context?: React.ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Caret after any prefilled text, so typing continues the sentence.
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusKey]);

  return (
    // No top border: the transcript scrolls behind the footer, which is what the
    // gradient in `ChatTranscript`'s scroller edge is for.
    <div className="flex shrink-0 flex-col gap-1.5 bg-background-bright px-3 pb-3 pt-1">
      {context}
      <div className="rounded-md border border-border-bright bg-background-bright p-1 transition focus-within:border-border-brighter">
        <div className="flex items-end gap-1">
          {/* One text line tall at rest (matches the button height), grows with
              content up to the cap. rows={1} + field-sizing-content do the work. */}
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSubmit();
              }
            }}
            placeholder="Type a message…"
            aria-label="Message the dashboard agent"
            className={cn(
              "max-h-[40vh] flex-1 resize-none border-0 bg-transparent px-1.5 py-0.5 text-sm leading-6 text-text-bright placeholder-text-dimmed outline-hidden ring-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control field-sizing-content focus:outline-hidden focus:ring-0"
            )}
          />
          {isStreaming ? (
            // Grey, not red: stopping is a normal thing to do mid-answer, not a
            // destructive action.
            <Button
              variant="minimal/small"
              className="aspect-square h-6 p-1"
              aria-label="Stop generating"
              tooltip="Stop generating"
              onClick={onStop}
              LeadingIcon={<StopIcon className="size-4 text-text-dimmed" />}
            />
          ) : (
            <Button
              variant="primary/small"
              className="aspect-square h-6 p-1"
              aria-label="Send"
              tooltip="Send"
              onClick={onSubmit}
              disabled={!value.trim()}
              LeadingIcon={<ArrowUpIcon className="size-4" />}
            />
          )}
        </div>
      </div>
    </div>
  );
}
