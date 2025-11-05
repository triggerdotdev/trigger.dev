import { Outlet } from "@remix-run/react";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Tabs } from "~/components/primitives/Tabs";

export default function Story() {
  return (
    <div className="flex items-start justify-center gap-20 pt-20">
      <div className="flex flex-col gap-4">
        <div className="flex h-fit flex-col">
          <div className="flex flex-col gap-2">
            <Header1 spacing className="font-mono">
              {"<Tabs/>"} (updates the URL)
            </Header1>
            <Paragraph>Variant="underline"</Paragraph>
          </div>
          <Tabs
            tabs={[
              { label: "First tab", to: "1" },
              { label: "Second tab", to: "2" },
              { label: "Third tab", to: "3" },
            ]}
            layoutId="my-tabs-1"
            variant="underline"
          />
          <Outlet />
        </div>
        <div className="flex h-fit flex-col gap-2">
          <Paragraph>Variant="pipe-divider"</Paragraph>
          <Tabs
            tabs={[
              { label: "First tab", to: "1" },
              { label: "Second tab", to: "2" },
              { label: "Third tab", to: "3" },
            ]}
            layoutId="my-tabs-2"
            variant="pipe-divider"
          />
          <Outlet />
        </div>
        <div className="flex h-fit flex-col gap-2">
          <Paragraph>Variant="segmented"</Paragraph>
          <Tabs
            tabs={[
              { label: "First tab", to: "1" },
              { label: "Second tab", to: "2" },
              { label: "Third tab", to: "3" },
            ]}
            layoutId="my-tabs-3"
            variant="segmented"
          />
          <Outlet />
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Header1 className="font-mono">{"<ClientTabs/>"}</Header1>
            <Paragraph>Variant="underline"</Paragraph>
          </div>
          <ClientTabs defaultValue="tab-1">
            <div className="flex items-center gap-4">
              <ClientTabsList variant="underline">
                <ClientTabsTrigger
                  value={"tab-1"}
                  variant="underline"
                  layoutId="client-tabs-underline"
                >
                  Tab 1
                </ClientTabsTrigger>
                <ClientTabsTrigger
                  value={"tab-2"}
                  variant="underline"
                  layoutId="client-tabs-underline"
                >
                  Tab 2
                </ClientTabsTrigger>
                <ClientTabsTrigger
                  value={"tab-3"}
                  variant="underline"
                  layoutId="client-tabs-underline"
                >
                  Tab 3
                </ClientTabsTrigger>
              </ClientTabsList>
            </div>
            <ClientTabsContent value={"tab-1"}>Tab 1</ClientTabsContent>
            <ClientTabsContent value={"tab-2"}>Tab 2</ClientTabsContent>
            <ClientTabsContent value={"tab-3"}>Tab 3</ClientTabsContent>
          </ClientTabs>
        </div>
        <div>
          <Paragraph>Variant="segmented"</Paragraph>
          <ClientTabs defaultValue="tab-1">
            <div className="flex items-center gap-4">
              <ClientTabsList variant="segmented">
                <ClientTabsTrigger
                  value={"tab-1"}
                  variant="segmented"
                  layoutId="client-tabs-segmented"
                >
                  Tab 1
                </ClientTabsTrigger>
                <ClientTabsTrigger
                  value={"tab-2"}
                  variant="segmented"
                  layoutId="client-tabs-segmented"
                >
                  Tab 2
                </ClientTabsTrigger>
                <ClientTabsTrigger
                  value={"tab-3"}
                  variant="segmented"
                  layoutId="client-tabs-segmented"
                >
                  Tab 3
                </ClientTabsTrigger>
              </ClientTabsList>
            </div>
            <ClientTabsContent value={"tab-1"}>Tab 1</ClientTabsContent>
            <ClientTabsContent value={"tab-2"}>Tab 2</ClientTabsContent>
            <ClientTabsContent value={"tab-3"}>Tab 3</ClientTabsContent>
          </ClientTabs>
        </div>
        <div>
          <Paragraph>Variant="pipe-divider"</Paragraph>
          <ClientTabs defaultValue="tab-1">
            <div className="flex items-center gap-4">
              <ClientTabsList variant="pipe-divider">
                <ClientTabsTrigger value={"tab-1"} variant="pipe-divider">
                  Tab 1
                </ClientTabsTrigger>
                <ClientTabsTrigger value={"tab-2"} variant="pipe-divider">
                  Tab 2
                </ClientTabsTrigger>
                <ClientTabsTrigger value={"tab-3"} variant="pipe-divider">
                  Tab 3
                </ClientTabsTrigger>
              </ClientTabsList>
            </div>
            <ClientTabsContent value={"tab-1"}>Tab 1</ClientTabsContent>
            <ClientTabsContent value={"tab-2"}>Tab 2</ClientTabsContent>
            <ClientTabsContent value={"tab-3"}>Tab 3</ClientTabsContent>
          </ClientTabs>
        </div>
      </div>
    </div>
  );
}
