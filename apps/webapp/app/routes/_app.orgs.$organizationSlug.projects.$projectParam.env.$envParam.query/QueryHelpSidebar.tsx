import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";
import type { QueryScope } from "~/services/queryService.server";
import { AITabContent } from "./AITabContent";
import { ExamplesContent } from "./ExamplesContent";
import { TableSchemaContent } from "./TableSchemaContent";
import { TRQLGuideContent } from "./TRQLGuideContent";
import type { AITimeFilter } from "./types";

export function QueryHelpSidebar({
  onTryExample,
  onQueryGenerated,
  onTimeFilterChange,
  getCurrentQuery,
  activeTab,
  onTabChange,
  aiFixRequest,
}: {
  onTryExample: (query: string, scope: QueryScope) => void;
  onQueryGenerated: (query: string) => void;
  onTimeFilterChange?: (filter: AITimeFilter) => void;
  getCurrentQuery: () => string;
  activeTab: string;
  onTabChange: (tab: string) => void;
  aiFixRequest: { prompt: string; key: number } | null;
}) {
  return (
    <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <ClientTabs
        value={activeTab}
        onValueChange={onTabChange}
        className="flex min-h-0 flex-col overflow-hidden pt-1"
      >
        <div className="h-fit overflow-x-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <ClientTabsList variant="underline" className="mx-3 shrink-0">
            <ClientTabsTrigger
              value="ai"
              variant="underline"
              layoutId="query-help-tabs"
              className="shrink-0"
            >
              <div className="flex items-center gap-0.5">
                <AISparkleIcon className="size-4" /> AI
              </div>
            </ClientTabsTrigger>
            <ClientTabsTrigger
              value="guide"
              variant="underline"
              layoutId="query-help-tabs"
              className="shrink-0"
            >
              Writing TRQL
            </ClientTabsTrigger>
            <ClientTabsTrigger
              value="schema"
              variant="underline"
              layoutId="query-help-tabs"
              className="shrink-0"
            >
              Table schema
            </ClientTabsTrigger>
            <ClientTabsTrigger
              value="examples"
              variant="underline"
              layoutId="query-help-tabs"
              className="shrink-0"
            >
              Examples
            </ClientTabsTrigger>
          </ClientTabsList>
        </div>
        <ClientTabsContent
          value="ai"
          className="min-h-0 flex-1 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <div className="min-w-64 p-3">
            <AITabContent
              onQueryGenerated={onQueryGenerated}
              onTimeFilterChange={onTimeFilterChange}
              getCurrentQuery={getCurrentQuery}
              aiFixRequest={aiFixRequest}
            />
          </div>
        </ClientTabsContent>
        <ClientTabsContent
          value="guide"
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <div className="min-w-64 p-3">
            <TRQLGuideContent onTryExample={onTryExample} />
          </div>
        </ClientTabsContent>
        <ClientTabsContent
          value="schema"
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <div className="min-w-64 p-3">
            <TableSchemaContent />
          </div>
        </ClientTabsContent>
        <ClientTabsContent
          value="examples"
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <div className="min-w-64 p-3">
            <ExamplesContent onTryExample={onTryExample} />
          </div>
        </ClientTabsContent>
      </ClientTabs>
    </div>
  );
}
