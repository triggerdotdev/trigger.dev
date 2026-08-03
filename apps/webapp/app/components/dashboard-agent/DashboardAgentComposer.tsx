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
  // The context chip. It describes the message about to be sent, so it belongs
  // in the composer's footer rather than at the top of the panel.
  context?: React.ReactNode;
  // Where this composer is mounted. `docked` (the default) is the panel footer
  // and renders exactly as it always has.
  layout?: DashboardAgentComposerLayout;
  // Off only where a composer isn't the thing the user came for — the storybook
  // gallery renders several at once and must not steal the page's focus.
  autoFocus?: boolean;
  /**
   * A suggested prompt shown as the placeholder while the field is empty.
   * Tab accepts it into the field as editable text — it is never sent on its
   * own. Once anything is typed, Tab goes back to being Tab.
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
    // Grey, not red: stopping is a normal thing to do mid-answer, not a
    // destructive action.
    <Button
      variant="minimal/small"
      className="aspect-square h-6 min-w-0 p-1"
      aria-label="Stop generating"
      tooltip="Stop generating"
      onClick={onStop}
      LeadingIcon={<StopIcon className="size-4 text-text-dimmed" />}
    />
  ) : (
    <Button
      variant="primary/small"
      className="aspect-square h-6 min-w-0 p-1"
      aria-label="Send"
      tooltip="Send"
      onClick={onSubmit}
      disabled={!value.trim()}
      LeadingIcon={<ArrowUpIcon className="size-4" />}
    />
  );

  return (
    // No top border: the transcript scrolls behind the footer, which is what the
    // gradient in `ChatTranscript`'s scroller edge is for.
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1.5",
        isHero ? "w-full" : "bg-background-bright px-3 pb-3 pt-1"
      )}
    >
      {/* In the hero the context chip rides on the field's own bottom row, next
          to the send button, so the field reads as one block. */}
      {isHero ? null : context}
      <div
        className={cn(
          "border border-border-bright bg-background-bright transition focus-within:border-border-brighter",
          isHero ? "rounded-lg p-2" : "rounded-md p-1"
        )}
      >
        <div className={isHero ? "flex flex-col gap-1.5" : "flex items-end gap-1"}>
          {/* Docked: one text line tall at rest (matches the button height),
              growing with content up to the cap. Hero: three lines at rest, the
              same growth. rows + field-sizing-content do the work. */}
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
              // Tab accepts the suggested placeholder into the field (still
              // editable, not sent). Only while empty — with text present, Tab
              // keeps its normal focus behavior.
              if (e.key === "Tab" && !e.shiftKey && placeholderSuggestion && value === "") {
                e.preventDefault();
                onChange(placeholderSuggestion);
                requestAnimationFrame(() => {
                  const el = ref.current;
                  el?.setSelectionRange(el.value.length, el.value.length);
                });
              }
            }}
            placeholder={
              placeholderSuggestion ? `${placeholderSuggestion} — Tab to use` : "Type a message…"
            }
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
