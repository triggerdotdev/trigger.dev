/**
 * Chat layout: the one place transcript layout is decided. A turn body composes
 * only the micro-layouts exported here.
 *
 *     ChatTranscript
 *       ChatTurn*                     one row of the transcript
 *         <body>                      one or more micro-layouts
 *
 * ## Composition rules
 *
 * 1. Spacing belongs to this file. Consumers never write padding, margin, gap or
 *    `space-y-*` at transcript level; add a micro-layout instead.
 *    `chat-layout.test.ts` enforces this for regions marked transcript-level.
 * 2. The inset has one owner. `ChatTurn` owns the horizontal inset,
 *    `ChatTranscript` the vertical padding and turn rhythm. A micro-layout adds
 *    the inset itself only when mounted outside a turn (`ChatInsetProvider`).
 * 3. Cards own everything inside their border; `ChatCardSlot` owns how they sit
 *    in the transcript.
 * 4. One live progress element per turn. Only `ChatProgress` renders
 *    `AgentSpinner`, and it stays mounted with only its label changing. A second
 *    spinner is a second focal point and restarts its animation on every remount.
 * 5. Role drives alignment only: user right-aligned in a bubble, assistant
 *    left-aligned and unboxed so only cards read as cards.
 */
import type { Ref } from "react";
import { createContext, Suspense, useContext } from "react";
import { StreamdownRenderer } from "~/components/code/StreamdownRenderer";
import { AgentSpinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";

/** The transcript's horizontal inset. Owned by `ChatTurn`. */
const TRANSCRIPT_INSET_X = "px-4";
/** The transcript's vertical padding. Owned by `ChatTranscript`. */
const TRANSCRIPT_INSET_Y = "py-4";
/** Rhythm between turns. Owned by `ChatTranscript`. */
const TURN_GAP = "space-y-4";
/** Rhythm between the micro-layouts inside one turn. */
const TURN_BODY_GAP = "space-y-2";
/** Gap inside a single-line row (icon to text, button to button). */
const ROW_GAP = "gap-2";
/** Gap inside a chip (icon to label). */
const CHIP_GAP = "gap-1.5";
/** Rhythm inside one unit — a banner and the text it introduces. */
const UNIT_GAP = "space-y-1.5";

const SCROLLER =
  "flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control";

/**
 * The soft edge at the bottom of the scroller. The transcript runs behind the
 * composer with no rule above it, so the fade is what signals more content.
 */
const SCROLL_FADE = "h-6 bg-linear-to-t from-background-bright to-transparent";

export type ChatRole = "user" | "assistant";

/**
 * Whether the surrounding element already applied the transcript inset, so a
 * micro-layout stays aligned both inside a turn and mounted loose.
 */
const ChatInsetContext = createContext(false);

/** Marks its subtree as already inset. Only layout components should use this. */
function ChatInsetProvider({ inset, children }: { inset: boolean; children: React.ReactNode }) {
  return <ChatInsetContext.Provider value={inset}>{children}</ChatInsetContext.Provider>;
}

/** The inset class a micro-layout must add itself, or undefined when nested. */
function useInsetClass(): string | undefined {
  return useContext(ChatInsetContext) ? undefined : TRANSCRIPT_INSET_X;
}

/**
 * The scrolling column, one per chat panel. `contentRef` must stay on the padded
 * column inside the scroller: `useTranscriptAutoScroll` walks up from it to find
 * the scroller.
 */
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

/**
 * One turn: carries the transcript's horizontal inset and, for an assistant turn,
 * the rhythm between the micro-layouts in its body. `bleed` drops the inset for
 * content that spans the panel edge to edge.
 */
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

/**
 * A text body. The assistant variant is the markdown path, rendered unboxed so
 * the box stays reserved for real cards mounted through `ChatCardSlot`. A
 * plain-text fallback shows while the markdown renderer loads.
 */
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

/**
 * Where a block that owns its own internals mounts: a rich card, a callout, a
 * chip row. Full width of the turn, no padding of its own.
 */
export function ChatCardSlot({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0">{children}</div>;
}

/**
 * The live progress line: a spinner and one line of dimmed text. The only place
 * `AgentSpinner` appears in the transcript. The host keeps it mounted for the
 * whole turn and swaps `children` (see `progress-line.ts`). It always carries the
 * transcript inset, from its turn or applied itself when mounted loose. The text
 * wraps, so the spinner pins to the first line rather than centring on the block.
 */
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

/**
 * Placement for a tool-call row, plus an optional `ChatProgress` under it while
 * the call is in flight. The row itself is the shared `ToolUseRow`.
 */
export function ChatToolRow({ children }: { children: React.ReactNode }) {
  return <div className={cn("min-w-0", TURN_BODY_GAP)}>{children}</div>;
}

/** An inline note in a voice that is not the agent's. */
export function ChatNote({ children }: { children: React.ReactNode }) {
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

/**
 * An icon and one line of status. State is carried by the icon, not the text
 * colour, so colour `icon` at the call site.
 */
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

/**
 * An unprompted turn: the banner that says what woke the chat and the body it
 * introduces, kept tighter than the normal turn-body gap so they read as one unit.
 */
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

/** Rhythm between the lines inside a system block. */
const BLOCK_LINE_GAP = "space-y-1";
/** The system block's own padding. Owned here, never set by its contents. */
const BLOCK_INSET = "px-3 py-2.5";

/**
 * A deterministic system/form block: the third voice in the transcript. Canned UI
 * must not use the agent's voice, so it reads as a bordered block with a
 * micro-label rather than prose or a rich card. `actions` is the footer row.
 */
export function ChatSystemBlock({
  label,
  icon,
  children,
  actions,
}: {
  /** The micro-label that says this is the system, not the agent. */
  label: string;
  /** Colour it at the call site: the state lives in the icon, not the text. */
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

/** A row of buttons. */
export function ChatActionsRow({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-1">{children}</div>;
}
