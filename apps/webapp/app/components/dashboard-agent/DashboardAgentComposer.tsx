import { ArrowUpIcon, StopIcon } from "@heroicons/react/20/solid";
import { sliceWellFormed } from "@internal/dashboard-agent-contracts";
import { useEffect, useRef, useState } from "react";
import { PlusIcon } from "~/assets/icons/PlusIcon";
import { Button } from "~/components/primitives/Buttons";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { cn } from "~/utils/cn";
import { composerEscapeAction } from "./composer-escape";
import { NEW_CHAT_SHORTCUT } from "./DashboardAgentHeader";
import {
  MAX_MESSAGE_CHARS,
  MESSAGE_CHARS_WARN_AT,
  messageCountAnnouncement,
} from "./message-limits";

export type DashboardAgentComposerLayout = "docked" | "hero";

/** Text past the bottom of the box, with a pixel of slack for fractional scroll positions. */
function hasTextBelow(el: HTMLTextAreaElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight > 1;
}

/** The docked composer's `trailingAction`. Styled against the panel's fill, so it lives here. */
export function NewChatButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="minimal/small"
      // `tertiary`, the variant's own hover, barely clears the panel's fill in the light themes.
      className="aspect-square h-7 min-w-0 shrink-0 rounded-full p-1 group-hover/button:bg-surface-control/50"
      aria-label="New chat"
      tooltip={
        <span className="flex items-center">
          New chat
          <ShortcutKey shortcut={NEW_CHAT_SHORTCUT} variant="medium" />
        </span>
      }
      onClick={onClick}
      LeadingIcon={<PlusIcon className="size-4 text-text-dimmed" />}
    />
  );
}

export function DashboardAgentComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  focusKey,
  context,
  trailingAction,
  notice,
  layout = "docked",
  autoFocus = true,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  // Bump to move focus back to the textarea.
  focusKey?: string | number;
  context?: React.ReactNode;
  // Rendered just before Send, in the panel's bottom-right corner.
  trailingAction?: React.ReactNode;
  // Rendered under the panel, centred, between it and the panel's AI disclosure.
  notice?: React.ReactNode;
  layout?: DashboardAgentComposerLayout;
  autoFocus?: boolean;
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

  // Drives the bottom fade. Typing and scrolling update it in their handlers; this catches the
  // box itself changing size: growing with the text, the panel resizing, 40vh following the window.
  const [textBelow, setTextBelow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setTextBelow(hasTextBelow(el)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const isHero = layout === "hero";

  const sendButton = isStreaming ? (
    <Button
      variant="minimal/small"
      className="aspect-square h-7 min-w-0 rounded-full bg-surface-control p-1 hover:bg-surface-control-hover"
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
      className="aspect-square h-7 min-w-0 rounded-full p-1"
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
        // No bottom padding: the AI disclosure under the composer closes the panel.
        isHero ? "w-full" : "bg-background-bright px-3 pt-1"
      )}
    >
      {/* One panel holds the message, its context and every action on it. `background-hover`
          is a step lighter than the panel in the dark themes and a step darker in the light ones.
          No top padding: the text box carries it, so it scrolls away with the text instead of
          leaving a gap above it, and `overflow-hidden` keeps that text inside the round corners. */}
      <div className="flex flex-col gap-1.5 overflow-hidden rounded-xl border border-border-bright/50 bg-background-hover px-2 pb-2">
        {/* Out past the panel's right padding, so the scrollbar sits by the panel's edge; the text
            box's wider right padding keeps the text where it was. */}
        <div className="relative -mr-2">
          <textarea
            ref={ref}
            rows={isHero ? 3 : 1}
            value={value}
            // Clamped as well as `maxLength`, so a programmatic paste can't exceed the cap.
            maxLength={MAX_MESSAGE_CHARS}
            onChange={(e) => {
              escapeGuardArmed.current = true;
              onChange(sliceWellFormed(e.target.value, MAX_MESSAGE_CHARS));
              setTextBelow(hasTextBelow(e.target));
            }}
            onScroll={(e) => setTextBelow(hasTextBelow(e.currentTarget))}
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
            }}
            placeholder="Ask anything…"
            aria-label="Message the dashboard agent"
            className={cn(
              "block max-h-[40vh] w-full resize-none border-0 bg-transparent pb-0.5 pl-1.5 pr-3.5 pt-2.5 text-sm leading-[1.5] text-text-bright placeholder-text-dimmed outline-hidden ring-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control field-sizing-content focus:outline-hidden focus:ring-0",
              // `field-sizing-content` ignores `rows`, so the blank state's extra room is a floor:
              // three lines, plus the top padding the panel handed down.
              isHero && "min-h-[calc(3lh+0.5rem)]"
            )}
          />
          {/* The transcript's fade, in the panel's fill. It clears once scrolled to the bottom, so
              the last line is never under it. */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-background-hover to-transparent transition-opacity",
              textBelow ? "opacity-100" : "opacity-0"
            )}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {/* Same inset as the text box, so the context starts where the message does. Nudged 3px
              below centre: centred, its baseline sits 4px further from the bottom edge than its
              first letter does from the left. */}
          <div className="flex min-w-0 translate-y-[3px] px-1.5">{context}</div>
          {/* `shrink-0`, so a long context truncates instead of squeezing Send out. The buttons
              are circles, and `focus-custom` would draw their focus ring as a rounded square. */}
          <div className="ml-auto flex shrink-0 items-center gap-1 [&_button:focus-visible]:rounded-full">
            {/* Only near the limit: a normal message never sees a counter. */}
            {value.length >= MESSAGE_CHARS_WARN_AT ? (
              <span
                aria-hidden
                className={cn(
                  "px-1 text-xxs tabular-nums",
                  value.length >= MAX_MESSAGE_CHARS ? "text-error" : "text-text-dimmed"
                )}
              >
                {value.length} / {MAX_MESSAGE_CHARS}
              </span>
            ) : null}
            {trailingAction}
            {sendButton}
          </div>
        </div>
      </div>
      {notice ? <div className="flex justify-center">{notice}</div> : null}
      {/* Mounted from the start, empty until there is something to say: a region that appears
          with its first message goes unannounced in several screen readers. */}
      <p className="sr-only" aria-live="polite">
        {messageCountAnnouncement(value.length)}
      </p>
    </div>
  );
}
