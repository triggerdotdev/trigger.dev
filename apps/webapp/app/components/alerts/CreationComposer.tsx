import { ArrowUpIcon, StopIcon } from "@heroicons/react/20/solid";
import { sliceWellFormed } from "@internal/dashboard-agent-contracts";
import { useEffect, useRef } from "react";
import { composerEscapeAction } from "~/components/dashboard-agent/composer-escape";
import {
  MAX_MESSAGE_CHARS,
  MESSAGE_CHARS_WARN_AT,
  messageCountAnnouncement,
} from "~/components/dashboard-agent/message-limits";
import { Button } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";

export function CreationComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  trailingAction,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  trailingAction?: React.ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const escapeGuardArmed = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const sendButton = isStreaming ? (
    <Button
      variant="minimal/small"
      className="aspect-square h-7 min-w-0 bg-surface-control p-1 hover:bg-surface-control-hover"
      aria-label="Stop generating"
      tooltip="Stop generating"
      onClick={onStop}
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
    <div className="flex shrink-0 flex-col gap-1.5 bg-background-bright px-3 pb-3 pt-1">
      <div className="rounded-md border border-border-bright/50 bg-background-bright p-1 transition focus-within:border-ring">
        <div className="flex items-end gap-1">
          <textarea
            ref={ref}
            data-agent-composer=""
            rows={1}
            value={value}
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
              if (e.key === "Escape" && e.nativeEvent.isComposing) {
                e.preventDefault();
                return;
              }
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
            className="max-h-[40vh] flex-1 resize-none border-0 bg-transparent px-1.5 py-0.5 text-sm leading-[1.5] text-text-bright placeholder-text-dimmed outline-hidden ring-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control field-sizing-content focus:outline-hidden focus:ring-0"
          />
          {sendButton}
        </div>
      </div>
      {trailingAction ? (
        <div className="flex min-w-0 items-center justify-end gap-2">
          <div className="shrink-0">{trailingAction}</div>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {messageCountAnnouncement(value.length)}
      </p>
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
