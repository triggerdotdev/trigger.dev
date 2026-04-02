import { useState } from "react";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { Button } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  useFrozenValue,
} from "~/components/primitives/Resizable";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { cn } from "~/utils/cn";

type DemoItem = {
  id: string;
  name: string;
  status: "completed" | "running" | "failed" | "queued";
  duration: string;
  task: string;
};

const demoItems: DemoItem[] = [
  { id: "run_a1b2c3d4", name: "Process invoices", status: "completed", duration: "2.3s", task: "invoice/process" },
  { id: "run_e5f6g7h8", name: "Send welcome email", status: "running", duration: "0.8s", task: "email/welcome" },
  { id: "run_i9j0k1l2", name: "Generate report", status: "failed", duration: "12.1s", task: "report/generate" },
  { id: "run_m3n4o5p6", name: "Sync inventory", status: "completed", duration: "5.7s", task: "inventory/sync" },
  { id: "run_q7r8s9t0", name: "Resize images", status: "queued", duration: "—", task: "image/resize" },
  { id: "run_u1v2w3x4", name: "Update search index", status: "completed", duration: "1.1s", task: "search/index" },
  { id: "run_y5z6a7b8", name: "Calculate analytics", status: "running", duration: "8.4s", task: "analytics/calc" },
  { id: "run_c9d0e1f2", name: "Deploy preview", status: "completed", duration: "34.2s", task: "deploy/preview" },
  { id: "run_g3h4i5j6", name: "Run migrations", status: "failed", duration: "0.3s", task: "db/migrate" },
  { id: "run_k7l8m9n0", name: "Notify Slack", status: "completed", duration: "0.5s", task: "notify/slack" },
];

const statusColors: Record<DemoItem["status"], string> = {
  completed: "text-success",
  running: "text-blue-500",
  failed: "text-error",
  queued: "text-text-dimmed",
};

function DetailPanel({ item, onClose }: { item: DemoItem; onClose: () => void }) {
  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden border-b border-grid-bright px-3 pr-2">
        <Header2 className="truncate text-text-bright">{item.name}</Header2>
        <Button
          onClick={onClose}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <Property.Table>
          <Property.Item>
            <Property.Label>Run ID</Property.Label>
            <Property.Value>{item.id}</Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Task</Property.Label>
            <Property.Value>{item.task}</Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Status</Property.Label>
            <Property.Value>
              <span className={statusColors[item.status]}>
                {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
              </span>
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Duration</Property.Label>
            <Property.Value>{item.duration}</Property.Value>
          </Property.Item>
        </Property.Table>
        <div className="mt-4">
          <Paragraph variant="small" className="text-text-dimmed">
            This is a demo detail panel showing the animated slide-in/out behavior using
            react-window-splitter&apos;s collapseAnimation. Click a different row to change the
            detail, or press Esc / click the close button to dismiss.
          </Paragraph>
        </div>
      </div>
    </div>
  );
}

export default function Story() {
  const [selectedItem, setSelectedItem] = useState<DemoItem | null>(null);
  const show = !!selectedItem;
  const frozenItem = useFrozenValue(selectedItem);
  const displayItem = selectedItem ?? frozenItem;

  return (
    <div className="h-full">
      <ResizablePanelGroup orientation="horizontal" className="max-h-full">
        <ResizablePanel id="animated-panel-main" min="200px">
          <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden">
            <div className="flex items-center border-b border-grid-bright px-3">
              <Header2 className="text-text-bright">Runs</Header2>
            </div>
            <Table containerClassName="max-h-full" showTopBorder={false}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Run ID</TableHeaderCell>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Task</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell alignment="right">Duration</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {demoItems.map((item) => (
                  <TableRow key={item.id} isSelected={selectedItem?.id === item.id}>
                    <TableCell onClick={() => setSelectedItem(item)} isTabbableCell>
                      {item.id}
                    </TableCell>
                    <TableCell onClick={() => setSelectedItem(item)}>{item.name}</TableCell>
                    <TableCell onClick={() => setSelectedItem(item)}>{item.task}</TableCell>
                    <TableCell onClick={() => setSelectedItem(item)}>
                      <span className={statusColors[item.status]}>
                        {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                      </span>
                    </TableCell>
                    <TableCell onClick={() => setSelectedItem(item)} alignment="right">
                      {item.duration}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </ResizablePanel>
        <ResizableHandle
          id="animated-panel-handle"
          className={cn("transition-opacity duration-200", !show && "pointer-events-none opacity-0")}
        />
        <ResizablePanel
          id="animated-panel-detail"
          min="280px"
          default="380px"
          max="500px"
          className="overflow-hidden"
          collapsible
          collapsed={!show}
          onCollapseChange={() => {}}
          collapsedSize="0px"
          collapseAnimation={{ easing: "ease-in-out", duration: 200 }}
        >
          <div className="h-full" style={{ minWidth: 280 }}>
            {displayItem && (
              <DetailPanel
                key={displayItem.id}
                item={displayItem}
                onClose={() => setSelectedItem(null)}
              />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
