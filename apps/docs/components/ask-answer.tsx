"use client";

// An Ask AI answer: its tool trail, markdown with citation links and highlighted code, sources and
// feedback. Shared by the panel and the search dialog.

import type { UIMessage } from "ai";
import { createMarkdownRenderer } from "fumadocs-core/content/md";
import { remarkGfm } from "fumadocs-core/mdx-plugins/remark-gfm";
import { FileText, Search, ThumbsDown, ThumbsUp } from "lucide-react";
import {
  createContext,
  Fragment,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import Link from "next/link";
import type { ThemedToken } from "shiki/core";
import { track } from "@/lib/analytics";
import type { Source } from "@/lib/ask";
import { linkCitations } from "@/lib/citations";
import { basePath } from "@/lib/base-path";

const { Markdown } = createMarkdownRenderer({ remarkPlugins: [remarkGfm] });

/** Sources a message's tool calls numbered, by number. */
function messageSources(m: UIMessage): Map<number, Source> {
  const out = new Map<number, Source>();
  for (const p of m.parts)
    if (p.type.startsWith("tool-") && "output" in p && p.output)
      for (const s of (p.output as { sources?: Source[] }).sources ?? []) out.set(s.n, s);
  return out;
}

// The answer being rendered, so a code block can tell whether its fence has closed yet.
const AnswerText = createContext({ text: "", streaming: false });
// Highlighted blocks by language and code: a closed block is highlighted once, and an answer moved
// from search to the panel shows its code highlighted from the first frame.
type Token = Pick<ThemedToken, "content" | "htmlStyle">;
const highlighted = new Map<string, Token[][] | null>();

/** A fenced code block in an answer, highlighted like the page code blocks once its fence closes
 * (plain text while it streams). Shiki loads on the first block. */
function AnswerCode({ children }: ComponentProps<"pre">) {
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children)
    ? children
    : undefined;
  const lang = /language-(\S+)/.exec(code?.props.className ?? "")?.[1]?.toLowerCase() ?? "";
  const source = String(code?.props.children ?? "").replace(/\n$/, "");
  const { text, streaming } = useContext(AnswerText);
  // A block still being written runs to the end of the answer; a closed one is followed by its fence.
  const open = streaming && text.trimEnd().endsWith(source.trimEnd());
  const key = `${lang}\0${source}`;
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (open || !lang || highlighted.has(key)) return;
    let live = true;
    import("@/lib/ask-highlight")
      .then((m) => m.highlightTokens(source, lang))
      .then(
        (lines) => {
          highlighted.set(key, lines);
          if (live) rerender();
        },
        () => highlighted.set(key, null)
      );
    return () => {
      live = false;
    };
  }, [key, open, lang, source]);

  const lines = highlighted.get(key) ?? source.split("\n").map((content): Token[] => [{ content }]);
  return (
    <CodeBlock className="my-3">
      <Pre>
        <code>
          {lines.map((line, i) => (
            // Lines joined by newlines, as Shiki writes them on pages (copy keeps the line breaks).
            <Fragment key={i}>
              {i > 0 && "\n"}
              <span className="line">
                {line.map((t, j) => (
                  <span key={j} style={t.htmlStyle as CSSProperties | undefined}>
                    {t.content}
                  </span>
                ))}
              </span>
            </Fragment>
          ))}
        </code>
      </Pre>
    </CodeBlock>
  );
}

const docsPath = (url: string) =>
  url.replace(/^https:\/\/trigger\.dev\/docs/, "").replace(/#.*$/, "") || "/";
/** Doc links stay on this site: absolute docs URLs and the model's bare paths (`/machines`) both get `/docs`. */
const localHref = (url: string) =>
  url.startsWith("/") && !url.startsWith(basePath)
    ? `${basePath}${url}`
    : url.replace(/^https:\/\/trigger\.dev/, "");

/** A link in an answer. Docs pages navigate client-side and other sites open in a new tab, so the
 * panel and the conversation stay open (a full page load would reset both). */
function AnswerLink({ href = "", children, ...rest }: ComponentProps<"a">) {
  const local = localHref(href);
  if (local === basePath || local.startsWith(`${basePath}/`) || local.startsWith(`${basePath}#`))
    return (
      <Link href={local.slice(basePath.length) || "/"} {...rest}>
        {children}
      </Link>
    );
  if (/^https?:/.test(local))
    return (
      <a href={local} target="_blank" rel="noreferrer" {...rest}>
        {children}
      </a>
    );
  return (
    <a href={local} {...rest}>
      {children}
    </a>
  );
}

function Trail({ m }: { m: UIMessage }) {
  const steps = m.parts.filter((p) => p.type === "tool-search_docs" || p.type === "tool-read_page");
  if (!steps.length) return null;
  return (
    <ol className="mb-3 flex flex-col gap-1 text-xs text-fd-muted-foreground">
      {steps.map((p, i) => {
        const failed = "state" in p && p.state === "output-error";
        const done = failed || ("state" in p && p.state === "output-available");
        const input = ("input" in p ? p.input : undefined) as
          | { query?: string; path?: string }
          | undefined;
        const out = ("output" in p ? p.output : undefined) as { sources?: Source[] } | undefined;
        const isSearch = p.type === "tool-search_docs";
        const Icon = isSearch ? Search : FileText;
        const label = failed
          ? isSearch
            ? `Couldn't search “${input?.query ?? "…"}”`
            : `Couldn't read ${input?.path ?? "page"}`
          : isSearch
            ? `${done ? "Searched" : "Searching"} “${input?.query ?? "…"}”${done ? `, ${out?.sources?.length ?? 0} sections` : ""}`
            : `${done ? "Read" : "Reading"} ${out?.sources?.[0]?.title ?? input?.path ?? "page"}`;
        return (
          <li key={i} className="flex items-center gap-1.5">
            <Icon className={`size-3 shrink-0 ${done ? "" : "animate-pulse text-fd-primary"}`} />
            <span className="truncate">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The answer text of an assistant message and the sources it cites, in reading order. */
export function answerOf(m: UIMessage) {
  const sources = messageSources(m);
  // Only the text after the last tool call is the answer; anything before is the model thinking aloud.
  const lastTool = m.parts.findLastIndex((p) => p.type.startsWith("tool-"));
  const text = m.parts
    .slice(lastTool + 1)
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  // Show citations as 1, 2, 3 in reading order, whatever numbers the tools handed out.
  const order = new Map<number, number>();
  for (const [, n] of text.matchAll(/\[(\d+)\]/g))
    if (sources.has(Number(n)) && !order.has(Number(n))) order.set(Number(n), order.size + 1);
  const cited = [...order.keys()].map((n) => sources.get(n)!);
  return { sources, text, order, cited };
}

export const textOf = (m?: UIMessage) =>
  m?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";

function AnswerFeedback({ question, cited }: { question: string; cited: Source[] }) {
  const [vote, setVote] = useState<"up" | "down">();
  return (
    <div className="mt-2 flex items-center gap-1 text-xs text-fd-muted-foreground">
      {vote ? (
        <span role="status">Thanks for the feedback.</span>
      ) : (
        <>
          <span className="me-1">Helpful?</span>
          {(["up", "down"] as const).map((v) => {
            const Icon = v === "up" ? ThumbsUp : ThumbsDown;
            return (
              <button
                key={v}
                type="button"
                aria-label={v === "up" ? "Helpful" : "Not helpful"}
                onClick={() => {
                  setVote(v);
                  track("docs_ask_ai_feedback", {
                    question,
                    helpful: v === "up",
                    cited: cited.map((s) => s.url),
                  });
                }}
                className="rounded p-1 hover:bg-fd-accent hover:text-fd-accent-foreground"
              >
                <Icon className="size-3.5" />
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

// Images in answers never load: an image URL the model writes could carry the conversation to
// another site. The alt text links to it instead.
function AnswerImage({ src, alt }: ComponentProps<"img">) {
  return typeof src === "string" && src ? <AnswerLink href={src}>{alt || src}</AnswerLink> : null;
}

export function Answer({
  m,
  streaming,
  question,
}: {
  m: UIMessage;
  streaming: boolean;
  question: string;
}) {
  const { sources, text, order, cited } = answerOf(m);
  const textValue = useMemo(() => ({ text, streaming }), [text, streaming]);
  const a = ({ href = "", children, ...rest }: ComponentProps<"a">) => {
    const n = Number(String(children));
    if (Number.isInteger(n) && sources.get(n)?.url === href)
      return (
        <AnswerLink
          href={href}
          title={sources.get(n)!.title}
          className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-px items-center justify-center rounded bg-fd-primary/15 px-1 align-middle text-[10px] font-semibold text-fd-primary no-underline hover:bg-fd-primary hover:text-fd-primary-foreground"
        >
          {order.get(n)}
        </AnswerLink>
      );
    return (
      <AnswerLink href={href} {...rest}>
        {children}
      </AnswerLink>
    );
  };
  return (
    <div>
      <Trail m={m} />
      {text ? (
        <div className="prose prose-sm max-w-none text-sm">
          <AnswerText value={textValue}>
            <Markdown components={{ a, img: AnswerImage, pre: AnswerCode }}>
              {linkCitations(text, sources)}
            </Markdown>
          </AnswerText>
        </div>
      ) : (
        streaming && <p className="text-sm text-fd-muted-foreground">Looking through the docs…</p>
      )}
      {cited.length > 0 && !streaming && (
        <div className="mt-3 border-t pt-2">
          <p className="mb-1 text-xs font-medium text-fd-muted-foreground">Sources</p>
          <ol className="flex flex-col">
            {cited.map((s) => (
              <li key={s.n}>
                <AnswerLink
                  href={s.url}
                  className="flex items-baseline gap-2 rounded px-1 py-1 text-sm hover:bg-fd-accent"
                >
                  <span className="w-4 shrink-0 text-xs font-semibold text-fd-primary">
                    {order.get(s.n)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate">{s.title}</span>
                    <span className="block truncate text-xs text-fd-muted-foreground">
                      {docsPath(s.url)}
                    </span>
                  </span>
                </AnswerLink>
              </li>
            ))}
          </ol>
        </div>
      )}
      {text && !streaming && <AnswerFeedback question={question} cited={cited} />}
    </div>
  );
}
