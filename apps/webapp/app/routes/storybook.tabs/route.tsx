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
    <div className="flex items-start justify-center gap-20 px-16 pt-20">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <div className="flex h-fit flex-col gap-2">
          <div className="flex flex-col gap-2">
            <Header1 spacing>{"<Tabs/>"} (updates the URL)</Header1>
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
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-2">
            <Header1 spacing>{"<ClientTabs/>"}</Header1>
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
                  First tab
                </ClientTabsTrigger>
                <ClientTabsTrigger
                  value={"tab-2"}
                  variant="underline"
                  layoutId="client-tabs-underline"
                >
                  Second tab
                </ClientTabsTrigger>
                <ClientTabsTrigger
                  value={"tab-3"}
                  variant="underline"
                  layoutId="client-tabs-underline"
                >
                  Third tab
                </ClientTabsTrigger>
              </ClientTabsList>
            </div>
            <ClientTabsContent value={"tab-1"}>
              <div className="flex items-center justify-center rounded bg-charcoal-700/50 py-8">
                <h1 className="text-5xl">1</h1>
              </div>
            </ClientTabsContent>
            <ClientTabsContent value={"tab-2"}>
              <div className="flex items-center justify-center rounded bg-charcoal-700/50 py-8">
                <h1 className="text-5xl">2</h1>
              </div>
            </ClientTabsContent>
            <ClientTabsContent value={"tab-3"}>
              <div className="flex items-center justify-center rounded bg-charcoal-700/50 py-8">
                <h1 className="text-5xl">3</h1>
              </div>
            </ClientTabsContent>
          </ClientTabs>
        </div>

        <div>
          <Paragraph spacing>Variant="pipe-divider"</Paragraph>
          <ClientTabs defaultValue="tab-1">
            <div className="flex items-center gap-4">
              <ClientTabsList variant="pipe-divider">
                <ClientTabsTrigger value={"tab-1"} variant="pipe-divider">
                  First tab
                </ClientTabsTrigger>
                <ClientTabsTrigger value={"tab-2"} variant="pipe-divider">
                  Second tab
                </ClientTabsTrigger>
                <ClientTabsTrigger value={"tab-3"} variant="pipe-divider">
                  Third tab
                </ClientTabsTrigger>
              </ClientTabsList>
            </div>
            <ClientTabsContent value={"tab-1"}>
              <div className="flex items-center justify-center rounded bg-charcoal-700/50 py-8">
                <h1 className="text-5xl">1</h1>
              </div>
            </ClientTabsContent>
            <ClientTabsContent value={"tab-2"}>
              <div className="flex items-center justify-center rounded bg-charcoal-700/50 py-8">
                <h1 className="text-5xl">2</h1>
              </div>
            </ClientTabsContent>
            <ClientTabsContent value={"tab-3"}>
              <div className="flex items-center justify-center rounded bg-charcoal-700/50 py-8">
                <h1 className="text-5xl">3</h1>
              </div>
            </ClientTabsContent>
          </ClientTabs>
        </div>
        <div>
          <Paragraph spacing>Variant="segmented"</Paragraph>
          <ClientTabs defaultValue="tab-1">
            <ClientTabsList variant="segmented">
              <ClientTabsTrigger
                value={"tab-1"}
                variant="segmented"
                layoutId="client-tabs-segmented"
              >
                First tab
              </ClientTabsTrigger>
              <ClientTabsTrigger
                value={"tab-2"}
                variant="segmented"
                layoutId="client-tabs-segmented"
              >
                Second tab
              </ClientTabsTrigger>
              <ClientTabsTrigger
                value={"tab-3"}
                variant="segmented"
                layoutId="client-tabs-segmented"
              >
                Third tab
              </ClientTabsTrigger>
            </ClientTabsList>
            <ClientTabsContent value={"tab-1"}>
              <div className="flex items-center justify-center rounded bg-charcoal-700/50 py-8">
                <h1 className="text-5xl">1</h1>
              </div>
            </ClientTabsContent>
            <ClientTabsContent value={"tab-2"}>
              <div className="flex items-center justify-center rounded bg-charcoal-700/50 py-8">
                <h1 className="text-5xl">2</h1>
              </div>
            </ClientTabsContent>
            <ClientTabsContent value={"tab-3"}>
              <div className="flex items-center justify-center rounded bg-charcoal-700/50 py-8">
                <h1 className="text-5xl">3</h1>
              </div>
            </ClientTabsContent>
          </ClientTabs>
        </div>
      </div>
    </div>
  );
}
