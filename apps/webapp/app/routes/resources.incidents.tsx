import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { json } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import { useCallback, useEffect } from "react";
import { LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useFeatures } from "~/hooks/useFeatures";
import { cn } from "~/utils/cn";
import { BetterStackClient } from "~/services/betterstack/betterstack.server";

export async function loader() {
  const client = new BetterStackClient();
  const result = await client.getIncidents();

  if (!result.success) {
    return json({ operational: true });
  }

  return json({
    operational: result.data.attributes.aggregate_state === "operational",
  });
}

export function IncidentStatusPanel({ isCollapsed = false }: { isCollapsed?: boolean }) {
  const { isManagedCloud } = useFeatures();
  if (!isManagedCloud) {
    return null;
  }

  const fetcher = useFetcher<typeof loader>();

  const fetchIncidents = useCallback(() => {
    if (fetcher.state === "idle") {
      fetcher.load("/resources/incidents");
    }
  }, [fetcher]);

  useEffect(() => {
    fetchIncidents();

    const interval = setInterval(fetchIncidents, 60 * 1000); // 1 minute

    return () => clearInterval(interval);
  }, []);

  const operational = fetcher.data?.operational ?? true;

  if (operational) {
    return null;
  }

  return (
    <div className="relative">
      {/* Expanded: Full incident panel */}
      <div
        className={cn(
          "grid transition-all duration-200 ease-in-out",
          isCollapsed ? "grid-rows-[0fr] opacity-0 pointer-events-none" : "grid-rows-[1fr] opacity-100"
        )}
      >
        <div className="overflow-hidden">
          <IncidentPanelContent />
        </div>
      </div>

      {/* Collapsed: Icon button with popover */}
      <div
        className={cn(
          "grid transition-all duration-200 ease-in-out",
          isCollapsed ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 pointer-events-none"
        )}
      >
        <div className="overflow-hidden">
          <div className="p-1">
            <Popover>
              <SimpleTooltip
                button={
                  <PopoverTrigger className="flex h-8 w-full items-center justify-center rounded bg-warning/10 transition-colors hover:bg-warning/20">
                    <ExclamationTriangleIcon className="size-5 text-warning" />
                  </PopoverTrigger>
                }
                content="Active incident"
                side="right"
                sideOffset={8}
                buttonClassName="!h-8 w-full"
                asChild
                disableHoverableContent
              />
              <PopoverContent side="right" sideOffset={8} align="start" className="!min-w-0 w-52 p-0">
                <IncidentPanelContent inPopover />
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>
    </div>
  );
}

function IncidentPanelContent({ inPopover = false }: { inPopover?: boolean }) {
  return (
    <div className={cn(!inPopover && "p-1")}>
      <div className="flex flex-col gap-2 rounded border border-warning/20 bg-warning/5 p-2 pt-1.5">
        <div className="flex items-center gap-1 border-b border-warning/20 pb-1 text-warning">
          <ExclamationTriangleIcon className="size-4" />
          <Paragraph variant="small/bright" className="text-warning">
            Active incident
          </Paragraph>
        </div>
        <Paragraph variant="extra-small/bright" className="text-warning/80">
          Our team is working on resolving the issue. Check our status page for more information.
        </Paragraph>
        <LinkButton
          variant="secondary/small"
          to="https://status.trigger.dev"
          target="_blank"
          fullWidth
          className="border-warning/20 bg-warning/10 hover:!border-warning/30 hover:!bg-warning/20"
        >
          <span className="text-warning">View status page</span>
        </LinkButton>
      </div>
    </div>
  );
}
