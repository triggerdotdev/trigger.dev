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

export function QueryHelpSidebar({
  onTryExample,
  onQueryGenerated,
  getCurrentQuery,
  activeTab,
  onTabChange,
  aiFixRequest,
}: {
  onTryExample: (query: string, scope: QueryScope) => void;
  onQueryGenerated: (query: string) => void;
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
        <ClientTabsList variant="underline" className="mx-3 shrink-0">
          <ClientTabsTrigger value="ai" variant="underline" layoutId="query-help-tabs">
            <div className="flex items-center gap-0.5">
              <AISparkleIcon className="size-4" /> AI
            </div>
          </ClientTabsTrigger>
          <ClientTabsTrigger value="guide" variant="underline" layoutId="query-help-tabs">
            Writing TRQL
          </ClientTabsTrigger>
          <ClientTabsTrigger value="schema" variant="underline" layoutId="query-help-tabs">
            Table schema
          </ClientTabsTrigger>
          <ClientTabsTrigger value="examples" variant="underline" layoutId="query-help-tabs">
            Examples
          </ClientTabsTrigger>
        </ClientTabsList>
        <ClientTabsContent
          value="ai"
          className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <AITabContent
            onQueryGenerated={onQueryGenerated}
            getCurrentQuery={getCurrentQuery}
            aiFixRequest={aiFixRequest}
          />
        </ClientTabsContent>
        <ClientTabsContent
          value="guide"
          className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <TRQLGuideContent onTryExample={onTryExample} />
        </ClientTabsContent>
        <ClientTabsContent
          value="schema"
          className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <TableSchemaContent />
        </ClientTabsContent>
        <ClientTabsContent
          value="examples"
          className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <ExamplesContent onTryExample={onTryExample} />
        </ClientTabsContent>
      </ClientTabs>
    </div>
  );
}

