import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";

export function TestSidebarTabs({
  activeTab,
  onTabChange,
  optionsContent,
  aiContent,
  schemaContent,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  optionsContent: React.ReactNode;
  aiContent: React.ReactNode;
  schemaContent: React.ReactNode;
}) {
  return (
    <ClientTabs
      value={activeTab}
      onValueChange={onTabChange}
      className="flex h-full min-h-0 flex-col overflow-hidden pt-1"
    >
      <div className="h-fit overflow-x-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <ClientTabsList variant="underline" className="mx-3 shrink-0">
          <ClientTabsTrigger
            value="options"
            variant="underline"
            layoutId="test-sidebar-tabs"
            className="shrink-0"
          >
            Options
          </ClientTabsTrigger>
          <ClientTabsTrigger
            value="ai"
            variant="underline"
            layoutId="test-sidebar-tabs"
            className="shrink-0"
          >
            <span className="flex items-center gap-0.5">
              <AISparkleIcon className="size-4" /> AI
            </span>
          </ClientTabsTrigger>
          <ClientTabsTrigger
            value="schema"
            variant="underline"
            layoutId="test-sidebar-tabs"
            className="shrink-0"
          >
            Schema
          </ClientTabsTrigger>
        </ClientTabsList>
      </div>
      <ClientTabsContent
        value="options"
        className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
      >
        {optionsContent}
      </ClientTabsContent>
      <ClientTabsContent
        value="ai"
        className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
      >
        <div className="min-w-64 p-3">{aiContent}</div>
      </ClientTabsContent>
      <ClientTabsContent
        value="schema"
        className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
      >
        <div className="min-w-64 p-3">{schemaContent}</div>
      </ClientTabsContent>
    </ClientTabs>
  );
}
