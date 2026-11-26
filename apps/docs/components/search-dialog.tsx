"use client";
import { Sparkles } from "lucide-react";
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
import { openAskAI } from "./ask-ai";
import { Highlighted } from "./search-highlight";

// The answer view and the AI SDK load with the first Ask, not with every page.
const AskInline = dynamic(() => import("./ask-inline").then((m) => m.AskInline));

const QUESTION =
  /^(how|what|why|when|where|which|who|can|could|does|do|is|are|should|will|would|i|my)\b/i;

/** Questions and longer queries get an "Ask AI" first row; short keyword queries don't. */
const looksLikeQuestion = (q: string) => {
  const t = q.trim();
  return t.endsWith("?") || QUESTION.test(t) || t.split(/\s+/).length >= 5;
};

// fumadocs' default search dialog, plus analytics and, when Ask AI is on, an "Ask AI" row that
// answers inline and hands the conversation to the side panel.
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
            keepOpen.current = true;
            setAsked(query);
            void import("./ask-chat").then((m) => m.askFromSearch(query));
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
            items={askRow ? [askRow, ...results] : undefined}
            Item={(p) => (
              <SearchDialogListItem
                {...p}
                renderMarkdown={(text) => <Highlighted text={text} query={query} />}
              />
            )}
          />
        )}
        <SearchDialogFooter>
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
