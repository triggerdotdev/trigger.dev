// All transcript spacing lives here. Consumers compose these micro-layouts and
// write no spacing classes of their own; `chat-layout.test.ts` enforces that.
import type { Ref } from "react";
import { createContext, Suspense, useContext } from "react";
import { StreamdownRenderer } from "~/components/code/StreamdownRenderer";
import { AgentSpinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

const TRANSCRIPT_INSET_X = "px-4";
const TRANSCRIPT_INSET_Y = "py-4";
const TURN_GAP = "space-y-4";
const TURN_BODY_GAP = "space-y-2";
const ROW_GAP = "gap-2";
const CHIP_GAP = "gap-1.5";
const UNIT_GAP = "space-y-1.5";

const SCROLLER =
  "flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control";

const SCROLL_FADE = "h-6 bg-linear-to-t from-background-bright to-transparent";

export type ChatRole = "user" | "assistant";

// True when an ancestor already applied the transcript inset.
const ChatInsetContext = createContext(false);

function ChatInsetProvider({ inset, children }: { inset: boolean; children: React.ReactNode }) {
  return <ChatInsetContext.Provider value={inset}>{children}</ChatInsetContext.Provider>;
}

function useInsetClass(): string | undefined {
  return useContext(ChatInsetContext) ? undefined : TRANSCRIPT_INSET_X;
}

// `contentRef` must stay on the padded column inside the scroller:
// `useTranscriptAutoScroll` walks up from it to find the scroller.
export function ChatTranscript({
  children,
  contentRef,
}: {
  children: React.ReactNode;
  contentRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className={SCROLLER}>
        <div ref={contentRef} className={cn(TRANSCRIPT_INSET_Y, TURN_GAP)}>
          {children}
        </div>
      </div>
      <div
        aria-hidden
        className={cn("pointer-events-none absolute inset-x-0 bottom-0", SCROLL_FADE)}
      />
    </div>
  );
}

export function ChatTurn({
  role = "assistant",
  bleed = false,
  children,
}: {
  role?: ChatRole;
  bleed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <ChatInsetProvider inset={!bleed}>
      <div
        className={cn(
          bleed ? undefined : TRANSCRIPT_INSET_X,
          "min-w-0",
          role === "user" ? "flex justify-end" : TURN_BODY_GAP
        )}
      >
        {children}
      </div>
    </ChatInsetProvider>
  );
}

export function ChatText({ role = "assistant", text }: { role?: ChatRole; text: string }) {
  if (role === "user") {
    return (
      <div className="max-w-[80%] rounded-lg bg-background-raised px-4 py-2.5 text-sm text-text-bright">
        <div className="whitespace-pre-wrap wrap-anywhere">{text}</div>
      </div>
    );
  }
  return (
    <div className="streamdown-container min-w-0 font-sans text-sm font-normal text-text-dimmed wrap-anywhere">
      <Suspense fallback={<span className="whitespace-pre-wrap">{text}</span>}>
        <StreamdownRenderer>{text}</StreamdownRenderer>
      </Suspense>
    </div>
  );
}

export function ChatCardSlot({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0">{children}</div>;
}

// The transcript's only `AgentSpinner`. Hosts keep it mounted for the whole turn
// and swap `children`; remounting restarts the animation.
export function ChatProgress({ children }: { children: React.ReactNode }) {
  const insetClass = useInsetClass();
  return (
    <div className={cn(insetClass, "flex items-start text-sm text-text-dimmed", ROW_GAP)}>
      {/* text-sm line box is 20px, the spinner 12px: 4px centres it on line one. */}
      <span className="mt-1 shrink-0">
        <AgentSpinner size={12} />
      </span>
      {children}
    </div>
  );
}

function ChatToolRow({ children }: { children: React.ReactNode }) {
  return <div className={cn("min-w-0", TURN_BODY_GAP)}>{children}</div>;
}

function ChatNote({ children }: { children: React.ReactNode }) {
  const insetClass = useInsetClass();
  return (
    <div
      className={cn(
        insetClass,
        "rounded-md border border-dashed border-border-bright bg-background-bright/40 px-3 py-2"
      )}
    >
      <span className="text-xs text-text-dimmed">{children}</span>
    </div>
  );
}

export function ChatStatusLine({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-start", ROW_GAP)}>
      {icon}
      <div className={cn("min-w-0", TURN_BODY_GAP)}>{children}</div>
    </div>
  );
}

export function ChatWakeSlot({
  banner,
  children,
}: {
  banner: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", UNIT_GAP)}>
      {banner}
      {children}
    </div>
  );
}

const BLOCK_LINE_GAP = "space-y-1";
const BLOCK_INSET = "px-3 py-2.5";

export function ChatSystemBlock({
  label,
  icon,
  children,
  actions,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-md border border-border-bright bg-background-dimmed",
        BLOCK_INSET,
        TURN_BODY_GAP
      )}
    >
      <div className={cn("flex items-center", CHIP_GAP)}>
        {icon}
        <span className="text-xxs font-medium uppercase tracking-wider text-text-dimmed">
          {label}
        </span>
      </div>
      <div className={cn("min-w-0", BLOCK_LINE_GAP)}>{children}</div>
      {actions ? <ChatActionsRow>{actions}</ChatActionsRow> : null}
    </div>
  );
}

export function ChatActionsRow({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-1">{children}</div>;
}
