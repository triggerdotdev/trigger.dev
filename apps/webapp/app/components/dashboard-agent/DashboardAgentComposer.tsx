import { PaperAirplaneIcon, StopIcon } from "@heroicons/react/20/solid";
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
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  // Bump to move focus back to the textarea — e.g. text was just prefilled from
  // outside the panel. Focus also happens on mount (panel open, chat switch).
  focusKey?: string | number;
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
    <div className="border-t border-grid-bright p-3">
      <div className="rounded-2xl border border-border-bright bg-background-bright p-2 transition focus-within:border-border-brighter">
        <div className="flex items-end gap-2">
          {/* One text line tall at rest (matches the Send button height), grows
              with content up to the cap. rows={1} + field-sizing-content do the
              work; the old min-h forced a second line's worth of empty space. */}
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
              "max-h-[40vh] flex-1 resize-none border-0 bg-transparent px-2 py-1 text-sm leading-6 text-text-bright placeholder-text-dimmed outline-hidden ring-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control field-sizing-content focus:outline-hidden focus:ring-0"
            )}
          />
          {/* mb-1 mirrors the textarea's py-1, so the button hugs the same
              inset as the text line instead of the padding box's edge. */}
          {isStreaming ? (
            <Button variant="danger/small" LeadingIcon={StopIcon} onClick={onStop} className="mb-1">
              Stop
            </Button>
          ) : (
            <Button
              variant="primary/small"
              LeadingIcon={PaperAirplaneIcon}
              onClick={onSubmit}
              disabled={!value.trim()}
              className="mb-1"
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
