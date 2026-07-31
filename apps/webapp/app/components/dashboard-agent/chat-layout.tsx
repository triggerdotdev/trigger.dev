/**
 * Chat layout — the one place transcript layout is decided.
 *
 * Every answer format the agent can produce gets a component here, and the chat
 * composes those components instead of writing its own spacing. If you are
 * building new chat content, you should not need to type a single padding,
 * margin or `space-y-*` class: pick the micro-layout that matches the format,
 * and the transcript's rules follow.
 *
 * ## Composition rules
 *
 * A transcript is:
 *
 *     ChatTranscript
 *       ChatTurn*                     one row of the transcript
 *         <body>                      one or more micro-layouts
 *
 * A turn body composes only these micro-layouts:
 *
 *   - `ChatText`        — markdown / plain text (assistant) or the user bubble
 *   - `ChatCardSlot`    — a full-width block that owns its own internals: a rich
 *                         card (diagnosis, investigation, report, chart), a
 *                         callout, a chip row
 *   - `ChatProgress`    — a spinner and one line of progress
 *   - `ChatPendingTool` — a tool call still in flight, as a compact pill
 *   - `ChatToolRow`     — a tool-call row, optionally with progress under it
 *   - `ChatNote`        — an inline system / interceptor note
 *   - `ChatWakeSlot`    — an unprompted turn: its banner and the narration under
 *                         it, kept together as one unit
 *   - `ChatStatusLine`  — an icon and one line of status
 *   - `ChatActionsRow`  — a row of buttons
 *
 * 1. **Spacing belongs to the library.** A consumer never writes `p-*`, `px-*`,
 *    `py-*`, `m-*`, `gap-*` or `space-y-*` at transcript level. If a new format
 *    needs spacing that isn't here, add a micro-layout — don't inline classes at
 *    the call site. A unit test (`chat-layout.test.ts`) enforces this for the
 *    regions the consumers mark as transcript-level.
 * 2. **The inset has one owner.** `ChatTurn` owns the horizontal inset,
 *    `ChatTranscript` the vertical padding and the rhythm between turns. A
 *    micro-layout mounted inside a turn adds no inset of its own; the same
 *    micro-layout mounted anywhere else applies the inset itself (see
 *    `ChatInsetProvider`). That is why `ChatProgress` is aligned with the
 *    transcript wherever it is mounted, including under a card.
 * 3. **Cards own their insides, the library owns their placement.** Anything
 *    within a card's border — its header strip, section padding, internal
 *    rhythm — is the card's business and must stay in the card. Anything about
 *    how the card sits in the transcript — full width, inset, distance to its
 *    neighbours — is `ChatCardSlot`'s, and a card must not set it.
 * 4. **Role drives alignment and surface.** `role="user"` is right-aligned in an
 *    indigo bubble; `role="assistant"` is left-aligned and near-full width in a
 *    soft dark card. Rich cards are still distinct — they carry headers, badges
 *    and actions inside the same border language.
 * 5. **Machine text is mono.** Anything the system names — a tool call, a step
 *    count, a duration — is set in mono; sentences the agent writes stay sans.
 */
import { ChevronRightIcon } from "@heroicons/react/20/solid";
import type { Ref } from "react";
import { createContext, Suspense, useContext } from "react";
import { StreamdownRenderer } from "~/components/code/StreamdownRenderer";
import { Spinner } from "~/components/primitives/Spinner";
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
/** Gap inside a chip (icon to label). Tighter than a row — same as a watch chip. */
const CHIP_GAP = "gap-1.5";
/** Rhythm inside one unit — a banner and the text it introduces. */
const UNIT_GAP = "space-y-1.5";

const SCROLLER =
  "flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control";

/**
 * The surface a turn's own content sits on: a soft dark card, one step above the
 * panel. Used by the assistant's text and by the pills, so a transcript reads as
 * one material.
 */
const SOFT_SURFACE = "border border-border-bright bg-background-hover";

/** Machine text — a tool name, a step count, a duration. See rule 5. */
const MONO_TEXT = "font-mono text-xs tracking-wide";

/**
 * A pill: a tool call, in flight or landed. Fully rounded and dashed, so it reads
 * as a trace of what happened rather than as a control to press.
 */
const PILL = "inline-flex min-w-0 max-w-full items-center rounded-full border-dashed px-3 py-1";

/**
 * The soft edge at the bottom of the scroller. There is no rule above the
 * composer — the transcript runs behind it — so this is what says the content
 * continues. Same idiom as the collapsed-content fade on the deployment page.
 */
const SCROLL_FADE = "h-6 bg-linear-to-t from-background-bright to-transparent";

export type ChatRole = "user" | "assistant";

/**
 * Whether the surrounding element already applied the transcript inset.
 *
 * Micro-layouts read this so the same component is correctly aligned both as a
 * turn body and when it is mounted loose in the transcript (a card rendering
 * `ChatProgress` under itself, for instance).
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
 * The scrolling column. One per chat panel: the vertical padding and the rhythm
 * between turns live here, so no consumer sets either.
 *
 * `contentRef` is attached to the padded column *inside* the scroller — that is
 * what `useTranscriptAutoScroll` expects (it walks up to find the scroller).
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
 * One turn: the row that carries the transcript's horizontal inset and, for an
 * assistant turn, the rhythm between the micro-layouts in its body.
 *
 * `bleed` drops the inset for content that is meant to span the panel edge to
 * edge — the context banner is the only such case today.
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
 * A text body.
 *
 * The assistant variant is the panel's markdown path, in a soft card: near-full
 * width, left-aligned, so an answer has an edge without shouting. A plain-text
 * fallback shows while the markdown renderer loads.
 *
 * The user variant is the accent bubble: indigo, right-aligned, tighter than full
 * width, so who said what is legible at a glance.
 */
export function ChatText({ role = "assistant", text }: { role?: ChatRole; text: string }) {
  if (role === "user") {
    return (
      <div className="max-w-[85%] rounded-2xl bg-indigo-600 px-4 py-2.5 text-sm text-white">
        <div className="whitespace-pre-wrap wrap-anywhere">{text}</div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        SOFT_SURFACE,
        "streamdown-container min-w-0 rounded-xl px-4 py-3 font-sans text-sm font-normal text-text-bright wrap-anywhere"
      )}
    >
      <Suspense fallback={<span className="whitespace-pre-wrap">{text}</span>}>
        <StreamdownRenderer>{text}</StreamdownRenderer>
      </Suspense>
    </div>
  );
}

/**
 * Where a block that owns its own internals mounts: a rich card, a callout, a
 * chip row. Full width of the turn, no padding of its own — the card's border is
 * the boundary between the library's rules and the card's own.
 */
export function ChatCardSlot({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0">{children}</div>;
}

/**
 * The progress line: a spinner and one line of dimmed mono text, left-aligned —
 * the same register as the step summary a finished turn leaves behind.
 *
 * It always carries the transcript's inset — either from the turn it sits in, or
 * by applying it itself when it is mounted loose (under a card, say). There is no
 * way to mount it flush against the panel edge, which is the point.
 *
 * The text wraps, so the spinner is pinned to the FIRST line (`items-start`) and
 * nudged down to sit optically centred against it — `items-center` floated it to
 * the middle of a two-line message.
 */
export function ChatProgress({ children }: { children: React.ReactNode }) {
  const insetClass = useInsetClass();
  return (
    <div className={cn(insetClass, MONO_TEXT, "flex items-start text-text-dimmed", ROW_GAP)}>
      {/* text-xs line box is 16px, the spinner 12px: 2px centres it on line one. */}
      <Spinner className="mt-0.5 size-3 shrink-0" />
      {children}
    </div>
  );
}

/**
 * A tool call still in flight, as a compact pill: a spinner and one short phrase
 * saying what the agent is doing.
 *
 * It replaces the tool row for the whole in-flight phase, so the transcript never
 * shows a half-streamed blob of input JSON that then flips to a card. The pill is
 * deliberately the smallest thing that fits the transcript's chip language (the
 * watch chips are its sibling) — when the call lands, whatever the result renders
 * as takes its place, and the jump is one line high.
 */
export function ChatPendingTool({ label }: { label: string }) {
  const insetClass = useInsetClass();
  return (
    <div className={cn(insetClass, "flex min-w-0")}>
      <span className={cn(PILL, SOFT_SURFACE, MONO_TEXT, "text-text-dimmed", CHIP_GAP)}>
        <Spinner className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    </div>
  );
}

/** How a landed tool call ended. Carried by the pill's dot, not by its text. */
export type ChatToolTone = "done" | "error";

const TOOL_DOT: Record<ChatToolTone, string> = {
  done: "bg-primary",
  error: "bg-error",
};

/**
 * A landed tool call, as a pill: a dot for how it ended, what it did in bright
 * mono, and what it did it to in dimmed mono. The chevron marks a pill whose
 * detail is longer than the room it has.
 *
 * `children` is anything that belongs under the row — a `ChatProgress` while the
 * turn continues, say.
 */
export function ChatToolRow({
  label,
  detail,
  tone = "done",
  children,
}: {
  label?: React.ReactNode;
  /** What the call was about: a query, an error message, a run id. Truncated. */
  detail?: React.ReactNode;
  tone?: ChatToolTone;
  children?: React.ReactNode;
}) {
  const insetClass = useInsetClass();
  return (
    <div className={cn(insetClass, "min-w-0", TURN_BODY_GAP)}>
      {label ? (
        <div className="flex min-w-0">
          <span className={cn(PILL, SOFT_SURFACE, MONO_TEXT, CHIP_GAP)}>
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TOOL_DOT[tone])} />
            <span className="shrink-0 text-text-bright">{label}</span>
            {detail ? <span className="truncate text-text-dimmed">{detail}</span> : null}
            {detail ? (
              <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-text-faint" />
            ) : null}
          </span>
        </div>
      ) : null}
      {children}
    </div>
  );
}

/**
 * An inline note in a voice that is not the agent's — a system aside, or the demo
 * interceptor saying what would have happened.
 */
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
 * An icon and one line of status. The text keeps the default colour — the state
 * is carried by the icon, the same rule the run status cells follow.
 *
 * `icon` is rendered as given (colour it at the call site, e.g. with
 * `AgentStatusIcon`); `children` is the line, plus anything that belongs under
 * it.
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
 * An unprompted turn: the banner that says what woke the chat, then the body it
 * introduces — tighter than the gap between two independent micro-layouts,
 * because the two read as one thing.
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

/** A row of buttons — a card's footer intents, a retry, a dismiss. */
export function ChatActionsRow({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-1">{children}</div>;
}
