"use client";
import { ChevronRight, FileText, Hash, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogListItem,
  SearchDialogOverlay,
  TagsList,
  TagsListItem,
} from "fumadocs-ui/components/dialog/search";
import type { SharedProps, TagItem } from "fumadocs-ui/contexts/search";
import { useDocsSearch } from "fumadocs-core/search/client";
import { fetchClient } from "fumadocs-core/search/client/fetch";
import { useOnChange } from "fumadocs-core/utils/use-on-change";
import { track } from "@/lib/analytics";
import { basePath } from "@/lib/base-path";
import { openAskAI } from "./ask-ai";
import { Highlighted } from "./search-highlight";

// The answer view and the AI SDK load with the first Ask, not with every page.
const AskInline = dynamic(() => import("./ask-inline").then((m) => m.AskInline));

const QUESTION =
  /^(how|what|why|when|where|which|who|can|could|does|do|is|are|should|will|would|i|my)\b/i;

/** Questions and longer queries get an "Ask AI" row after the results; short keyword queries don't. */
const looksLikeQuestion = (q: string) => {
  const t = q.trim();
  return t.endsWith("?") || QUESTION.test(t) || t.split(/\s+/).length >= 5;
};

/** Keyboard hint in the footer. */
const Key = ({ k, label }: { k: string; label: string }) => (
  <span className="inline-flex items-center gap-1.5">
    <kbd className="rounded border bg-fd-muted px-1 font-sans text-[0.6875rem] leading-4">{k}</kbd>
    {label}
  </span>
);

// fumadocs' search dialog with one-line rows (icon, title, nav path), plus analytics and, when
// Ask AI is on, an "Ask AI" row and button that answer inline and hand off to the side panel.
export default function DocsSearchDialog({
  api,
  tags = [],
  ask = false,
  ...props
}: SharedProps & { api?: string; tags?: TagItem[]; ask?: boolean }) {
  const [tag, setTag] = useState<string>();
  const search = useDocsSearch({ client: fetchClient({ api, tag }) });
  const results = Array.isArray(search.query.data) ? search.query.data : [];
  // The question answered inline; editing the query goes back to the results.
  const [asked, setAsked] = useState<string>();
  // Selecting a row closes the dialog; the Ask AI row keeps it open for the answer.
  const keepOpen = useRef(false);

  const query = search.search.trim();
  const showAnswer = ask && asked !== undefined && asked === query;
  const askQuery = () => {
    setAsked(query);
    void import("./ask-chat").then((m) => m.askFromSearch(query));
  };
  const askRow =
    ask && query && looksLikeQuestion(query)
      ? {
          id: "ask-ai",
          type: "action" as const,
          node: (
            <div className="flex min-w-0 items-center gap-2">
              <Sparkles className="size-4 shrink-0 text-fd-primary" />
              <span className="shrink-0 font-medium">Ask AI:</span>
              <span className="truncate text-fd-muted-foreground">{query}</span>
            </div>
          ),
          onSelect: () => {
            // Fumadocs closes the dialog after a row is picked; keep it open for the answer.
            keepOpen.current = true;
            askQuery();
          },
        }
      : undefined;

  // One event per settled query, not per keystroke: data changes after the debounce.
  useOnChange(search.query.data, (data) => {
    if (search.search.trim() && Array.isArray(data))
      track("docs_search", { query: search.search.trim(), tag, results: data.length });
  });

  return (
    <SearchDialog
      {...search}
      {...props}
      onOpenChange={(open) => {
        if (!open && keepOpen.current) {
          keepOpen.current = false;
          return;
        }
        if (!open) setAsked(undefined);
        props.onOpenChange(open);
      }}
      onSelect={(item) => {
        if (item.id === "ask-ai") return;
        // rank: 1-based row in the list as shown (page, heading and text rows all count).
        track("docs_search_result_clicked", {
          query: search.search.trim(),
          url: "url" in item ? item.url : undefined,
          type: item.type,
          rank: results.findIndex((r) => r.id === item.id) + 1,
        });
      }}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          {ask && (
            <button
              type="button"
              // The result list handles Enter on window and would open the selected row instead.
              onKeyDown={(e) => {
                if (e.key === "Enter") e.stopPropagation();
              }}
              onClick={() => {
                if (query) return askQuery();
                props.onOpenChange(false);
                openAskAI();
              }}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
            >
              <Sparkles className="size-3.5 text-fd-primary" />
              Ask AI
            </button>
          )}
          <SearchDialogClose />
        </SearchDialogHeader>
        {showAnswer ? (
          <AskInline
            question={query}
            onContinue={(streaming) => {
              track("docs_ask_ai_continued", { question: asked, streaming });
              setAsked(undefined);
              props.onOpenChange(false);
              openAskAI();
            }}
          />
        ) : (
          <SearchDialogList
            // After the results, so Enter opens the top result.
            items={askRow ? [...results, askRow] : undefined}
            Item={(p) => (
              <SearchDialogListItem {...p}>
                {p.item.type === "action" ? undefined : (
                  // A real link, so Cmd/Ctrl/middle-click opens a new tab. A plain click goes to the
                  // row's handler (client navigation, analytics); keyboard focus stays in the input.
                  <a
                    href={`${basePath}${p.item.url}`}
                    tabIndex={-1}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) e.stopPropagation();
                      else e.preventDefault();
                    }}
                    className="flex min-w-0 items-start gap-2.5 text-inherit no-underline"
                  >
                    {p.item.type === "page" ? (
                      <FileText className="mt-0.5 size-4 shrink-0 text-fd-muted-foreground" />
                    ) : (
                      <Hash className="mt-0.5 size-4 shrink-0 text-fd-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {typeof p.item.content === "string" ? (
                          <Highlighted text={p.item.content} query={query} />
                        ) : (
                          p.item.content
                        )}
                      </div>
                      {p.item.breadcrumbs && p.item.breadcrumbs.length > 0 && (
                        <div className="flex min-w-0 items-center text-xs text-fd-muted-foreground">
                          {p.item.breadcrumbs.map((b, i) => (
                            <span key={i} className="inline-flex min-w-0 items-center">
                              {i > 0 && <ChevronRight className="size-3 shrink-0" />}
                              <span className="truncate">{b}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </a>
                )}
              </SearchDialogListItem>
            )}
          />
        )}
        <SearchDialogFooter className="flex flex-wrap items-center justify-between gap-2">
          <div className="hidden items-center gap-3 text-xs text-fd-muted-foreground sm:flex">
            <Key k="↑↓" label="Select" />
            <Key k="↵" label="Open" />
            <Key k="Esc" label="Close" />
          </div>
          {tags.length > 0 && (
            <TagsList tag={tag} onTagChange={setTag} allowClear>
              {tags.map((t) => (
                <TagsListItem key={t.value} value={t.value}>
                  {t.name}
                </TagsListItem>
              ))}
            </TagsList>
          )}
        </SearchDialogFooter>
      </SearchDialogContent>
    </SearchDialog>
  );
}
