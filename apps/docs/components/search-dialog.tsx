"use client";
import { useState } from "react";
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
import { Highlighted } from "./search-highlight";

// fumadocs' default search dialog, plus analytics and matched words highlighted in results.
export default function DocsSearchDialog({
  api,
  tags = [],
  ...props
}: SharedProps & { api?: string; tags?: TagItem[] }) {
  const [tag, setTag] = useState<string>();
  const search = useDocsSearch({ client: fetchClient({ api, tag }) });
  const results = Array.isArray(search.query.data) ? search.query.data : [];
  const query = search.search.trim();

  // One event per settled query, not per keystroke: data changes after the debounce.
  useOnChange(search.query.data, (data) => {
    if (search.search.trim() && Array.isArray(data))
      track("docs_search", { query: search.search.trim(), tag, results: data.length });
  });

  return (
    <SearchDialog
      {...search}
      {...props}
      onSelect={(item) => {
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
        <SearchDialogList
          Item={(p) => (
            <SearchDialogListItem
              {...p}
              renderMarkdown={(text) => <Highlighted text={text} query={query} />}
            />
          )}
        />
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
