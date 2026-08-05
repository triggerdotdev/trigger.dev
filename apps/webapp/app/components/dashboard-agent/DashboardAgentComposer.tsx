import { ArrowUpIcon, StopIcon } from "@heroicons/react/20/solid";
import { useEffect, useRef } from "react";
import { Button } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";

/**
 * - `docked` — the composer at the bottom of the panel, one line tall at rest.
 * - `hero` — the composer in the blank-state hero: a large field with the send
 *   button (and the context chip) on a row inside it.
 */
export type DashboardAgentComposerLayout = "docked" | "hero";

export function DashboardAgentComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  focusKey,
  context,
  layout = "docked",
  autoFocus = true,
  placeholderSuggestion,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  // Bump to move focus back to the textarea — e.g. text was just prefilled from
  // outside the panel. Focus also happens on mount (panel open, chat switch).
  focusKey?: string | number;
  // The context chip, describing the message about to be sent.
  context?: React.ReactNode;
  layout?: DashboardAgentComposerLayout;
  // Off where several composers render at once (the storybook gallery) and must
  // not fight over the page's focus.
  autoFocus?: boolean;
  /**
   * A suggested prompt shown as the placeholder while the field is empty. Tab
   * accepts it into the field as editable text; it is never sent on its own.
   */
  placeholderSuggestion?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !autoFocus) return;
    el.focus();
    // Caret after any prefilled text, so typing continues the sentence.
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusKey, autoFocus]);

  const isHero = layout === "hero";

  const sendButton = isStreaming ? (
    <Button
      variant="minimal/small"
      // Filled neutral, not transparent: the white glyph needs a surface on the
      // light theme too, so the charcoal here is deliberately theme-stable.
      className="aspect-square h-7 min-w-0 bg-charcoal-600 p-1 hover:bg-charcoal-550"
      aria-label="Stop generating"
      tooltip="Stop generating"
      onClick={onStop}
      LeadingIcon={<StopIcon className="size-4 text-white" />}
    />
  ) : (
    <Button
      variant="primary/small"
      className="aspect-square h-7 min-w-0 p-1"
      aria-label="Send"
      tooltip="Send"
      onClick={onSubmit}
      disabled={!value.trim()}
      LeadingIcon={<ArrowUpIcon className="size-4 text-white" />}
    />
  );

  return (
    // No top border: the transcript scrolls behind the footer, which the
    // gradient on `ChatTranscript`'s scroller edge covers.
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1.5",
        isHero ? "w-full" : "bg-background-bright px-3 pb-3 pt-1"
      )}
    >
      {/* In the hero the context chip rides on the field's own bottom row instead. */}
      {isHero ? null : context}
      <div
        className={cn(
          "border border-border-bright bg-background-bright transition focus-within:border-border-brighter",
          isHero ? "rounded-lg p-2" : "rounded-md p-1"
        )}
      >
        <div className={isHero ? "flex flex-col gap-1.5" : "flex items-end gap-1"}>
          {/* rows + field-sizing-content set the resting height (docked: one
              line, matching the button; hero: three) and grow it to the cap. */}
          <textarea
            ref={ref}
            rows={isHero ? 3 : 1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSubmit();
              }
              // Tab accepts the suggested placeholder into the field. Only while
              // empty, so with text present Tab keeps its normal focus behavior.
              if (e.key === "Tab" && !e.shiftKey && placeholderSuggestion && value === "") {
                e.preventDefault();
                onChange(placeholderSuggestion);
                requestAnimationFrame(() => {
                  const el = ref.current;
                  el?.setSelectionRange(el.value.length, el.value.length);
                });
              }
            }}
            placeholder={placeholderSuggestion ?? "Type a message…"}
            aria-label="Message the dashboard agent"
            className={cn(
              "max-h-[40vh] flex-1 resize-none border-0 bg-transparent px-1.5 py-0.5 text-sm leading-6 text-text-bright placeholder-text-dimmed outline-hidden ring-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control field-sizing-content focus:outline-hidden focus:ring-0",
              isHero && "w-full"
            )}
          />
          {isHero ? (
            <div className="flex min-w-0 items-center justify-between gap-2">
              {context ?? <span />}
              {sendButton}
            </div>
          ) : (
            sendButton
          )}
        </div>
      </div>
    </div>
  );
}
