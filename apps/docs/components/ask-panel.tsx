"use client";

// The Ask AI panel's conversation, loaded on its first open (components/ask-ai.tsx keeps the
// button, the shortcut and the panel's state).

import { useChat } from "@ai-sdk/react";
import { ArrowUp, BookOpen, RotateCcw, Sparkles, Square, X } from "lucide-react";
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { track } from "@/lib/analytics";
import { Answer, textOf } from "./ask-answer";
import { askChat, sendAsk } from "./ask-chat";

export type PageContext = { path: string; title: string };

const GENERAL = [
  "How do I retry a task when it fails?",
  "How do I trigger a task from my Next.js backend and wait for the result?",
  "How do I limit concurrency per user?",
];
const ON_PAGE = ["Summarize this page", "Show me a complete example from this page"];

export function AskPanel({
  page,
  dropPage,
  input,
  setInput,
  close,
}: {
  page: PageContext | undefined;
  dropPage: () => void;
  input: string;
  setInput: (v: string) => void;
  close: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const { messages, status, stop, error, setMessages, clearError } = useChat({ chat: askChat });
  const busy = status === "submitted" || status === "streaming";

  // Mounted when the panel opens.
  useEffect(() => {
    inputRef.current?.focus();
  }, [page]);
  // Block body: newer browsers return a Promise from scrollIntoView, which React rejects as a cleanup.
  // Scroll once per new message, not per streamed token, so a long answer reads from its start.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const ask = (text: string) => {
    if (!text.trim() || busy) return;
    clearError();
    void sendAsk(text, { source: "panel", page: page?.path, turn: messages.length / 2 + 1 });
    setInput("");
  };
  const reset = () => {
    stop();
    setMessages([]);
    clearError();
  };

  return (
    <aside
      aria-label="Ask AI"
      className="fixed inset-0 z-50 flex flex-col border-fd-border bg-fd-background shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[30rem] sm:border-l"
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Sparkles className="size-4 text-fd-primary" />
        <h2 className="text-sm font-semibold">Ask AI</h2>
        <div className="ms-auto flex items-center gap-1">
          {messages.length > 0 && (
            <IconButton label="New conversation" onClick={reset}>
              <RotateCcw />
            </IconButton>
          )}
          <IconButton label="Close" onClick={close}>
            <X />
          </IconButton>
        </div>
      </header>

      <div
        className="flex-1 overflow-y-auto px-4 py-4"
        onClickCapture={(e) => {
          const link = (e.target as HTMLElement).closest("a");
          if (link) track("docs_ask_ai_citation_clicked", { href: link.getAttribute("href") });
        }}
      >
        {messages.length === 0 ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-fd-muted-foreground">
              Answers come from the Trigger.dev docs, with links to the sections they use.
            </p>
            <div className="flex flex-col items-start gap-1.5">
              {(page ? [...ON_PAGE, ...GENERAL.slice(0, 2)] : GENERAL).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => ask(q)}
                  className="rounded-md border px-2.5 py-1.5 text-left text-sm hover:bg-fd-accent"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <p
                  key={m.id}
                  className="self-end whitespace-pre-wrap rounded-lg bg-fd-secondary px-3 py-2 text-sm text-fd-secondary-foreground"
                >
                  {m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
                </p>
              ) : (
                <Answer
                  key={m.id}
                  m={m}
                  streaming={busy && i === messages.length - 1}
                  question={textOf(messages[i - 1])}
                />
              )
            )}
            {status === "submitted" && (
              <p className="text-sm text-fd-muted-foreground">Looking through the docs…</p>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-md border border-[var(--callout-warning)] px-3 py-2 text-sm"
              >
                {error.message || "Ask AI couldn't answer. Try again."}
              </p>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <form
        className="border-t px-4 pb-3 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        {page && (
          <p className="mb-2 flex items-center gap-1.5 text-xs text-fd-muted-foreground">
            <BookOpen className="size-3" />
            <span className="truncate">Current page: {page.title}</span>
            <button type="button" className="ms-auto shrink-0 underline" onClick={dropPage}>
              Don't use this page
            </button>
          </p>
        )}
        <div className="flex items-end gap-2 rounded-lg border bg-fd-card p-2 focus-within:ring-2 focus-within:ring-fd-ring">
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            maxLength={2000}
            placeholder="Ask a question about Trigger.dev"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter that confirms an IME candidate isn't a send (Safari reports it as keyCode 229).
              const composing = e.nativeEvent.isComposing || e.keyCode === 229;
              if (e.key === "Enter" && !e.shiftKey && !composing) {
                e.preventDefault();
                ask(input);
              }
            }}
            className="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-sm outline-none [field-sizing:content] placeholder:text-fd-muted-foreground"
          />
          {busy ? (
            <IconButton label="Stop" onClick={stop} solid>
              <Square />
            </IconButton>
          ) : (
            <IconButton label="Send" type="submit" solid disabled={!input.trim()}>
              <ArrowUp />
            </IconButton>
          )}
        </div>
        <p className="mt-2 text-[11px] text-fd-muted-foreground">
          AI answers can be wrong. Check the linked sections.
        </p>
      </form>
    </aside>
  );
}

function IconButton({
  label,
  solid,
  children,
  ...rest
}: ComponentProps<"button"> & { label: string; solid?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5 disabled:opacity-40 ${
        solid
          ? "bg-fd-primary text-fd-primary-foreground"
          : "text-fd-muted-foreground hover:bg-fd-accent"
      }`}
    >
      {children}
    </button>
  );
}
