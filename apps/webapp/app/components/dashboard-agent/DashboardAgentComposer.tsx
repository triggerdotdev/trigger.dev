import { ArrowUpIcon, StopIcon } from "@heroicons/react/20/solid";
import { sliceWellFormed } from "@internal/dashboard-agent-contracts";
import { useEffect, useRef } from "react";
import { Button } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";
import { composerEscapeAction } from "./composer-escape";
import {
  MAX_MESSAGE_CHARS,
  MESSAGE_CHARS_WARN_AT,
  messageCountAnnouncement,
} from "./message-limits";

export type DashboardAgentComposerLayout = "docked" | "hero";

export function DashboardAgentComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  focusKey,
  context,
  trailingAction,
  layout = "docked",
  autoFocus = true,
  placeholderSuggestion,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  // Bump to move focus back to the textarea.
  focusKey?: string | number;
  context?: React.ReactNode;
  // Rendered right-aligned next to `context`, below the input.
  trailingAction?: React.ReactNode;
  layout?: DashboardAgentComposerLayout;
  autoFocus?: boolean;
  // Shown as the placeholder while the field is empty. Tab accepts it as editable
  // text; it is never sent on its own.
  placeholderSuggestion?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Armed = the next Escape is taken by the draft guard; anything else re-arms it.
  const escapeGuardArmed = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || !autoFocus) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusKey, autoFocus]);

  const isHero = layout === "hero";

  const sendButton = isStreaming ? (
    <Button
      variant="minimal/small"
      className="aspect-square h-7 min-w-0 bg-surface-control p-1 hover:bg-surface-control-hover"
      aria-label="Stop generating"
      tooltip="Stop generating"
      onClick={onStop}
      // Not text-white: this button's surface goes light with the theme, unlike
      // the indigo Send button below it.
      LeadingIcon={<StopIcon className="size-4 text-text-bright" />}
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
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1.5",
        isHero ? "w-full" : "bg-background-bright px-3 pb-3 pt-1"
      )}
    >
      <div
        className={cn(
          "border border-border-bright bg-background-bright transition focus-within:border-border-brighter",
          isHero ? "rounded-lg p-2" : "rounded-md p-1"
        )}
      >
        <div className={isHero ? "flex flex-col gap-1.5" : "flex items-end gap-1"}>
          <textarea
            ref={ref}
            rows={isHero ? 3 : 1}
            value={value}
            // Clamped as well as `maxLength`, so a programmatic paste can't exceed the cap.
            maxLength={MAX_MESSAGE_CHARS}
            onChange={(e) => {
              escapeGuardArmed.current = true;
              onChange(sliceWellFormed(e.target.value, MAX_MESSAGE_CHARS));
            }}
            onBlur={() => {
              escapeGuardArmed.current = true;
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") {
                escapeGuardArmed.current = true;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSubmit();
              }
              // An Escape that cancels an IME composition is the user's, not the panel's: keep it
              // from the close handler without spending the draft guard's one step.
              if (e.key === "Escape" && e.nativeEvent.isComposing) {
                e.preventDefault();
                return;
              }
              // The first Escape on a draft is kept from the panel's close handler, which skips a
              // prevented event; a second one passes through unprevented and closes the panel.
              if (
                e.key === "Escape" &&
                composerEscapeAction(value, escapeGuardArmed.current) === "swallow"
              ) {
                e.preventDefault();
                escapeGuardArmed.current = false;
              }
              // Only while empty, so with text present Tab keeps its normal focus behavior.
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
      {isHero ? null : (
        <div className="flex min-w-0 items-center justify-between gap-2">
          {context ?? <span />}
          {trailingAction}
        </div>
      )}
      {/* Mounted from the start, empty until there is something to say: a region that appears
          with its first message goes unannounced in several screen readers. */}
      <p className="sr-only" aria-live="polite">
        {messageCountAnnouncement(value.length)}
      </p>
      {/* Only near the limit: a normal message never sees a counter. */}
      {value.length >= MESSAGE_CHARS_WARN_AT ? (
        <p
          aria-hidden
          className={cn(
            "self-end text-xxs tabular-nums",
            value.length >= MAX_MESSAGE_CHARS ? "text-error" : "text-text-dimmed"
          )}
        >
          {value.length} / {MAX_MESSAGE_CHARS}
        </p>
      ) : null}
    </div>
  );
}
