import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { json } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import { motion } from "framer-motion";
import { useCallback, useEffect } from "react";
import { LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useFeatures } from "~/hooks/useFeatures";
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
  const fetcher = useFetcher<typeof loader>();

  const fetchIncidents = useCallback(() => {
    if (fetcher.state === "idle") {
      fetcher.load("/resources/incidents");
    }
  }, []);

  useEffect(() => {
    if (!isManagedCloud) return;

    fetchIncidents();

    const interval = setInterval(fetchIncidents, 60 * 1000); // 1 minute

    return () => clearInterval(interval);
  }, [isManagedCloud, fetchIncidents]);

  const operational = fetcher.data?.operational ?? true;

  if (!isManagedCloud || operational) {
    return null;
  }

  return (
    <Popover>
      <div className="p-1">
        {/* Expanded panel - animated height and opacity */}
        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? 0 : "auto",
            opacity: isCollapsed ? 0 : 1,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <div className="flex flex-col gap-2 rounded border border-warning/20 bg-warning/5 p-2 pt-1.5">
            {/* Header */}
            <div className="flex items-center gap-1 border-b border-warning/20 pb-1 text-warning">
              <ExclamationTriangleIcon className="size-4" />
              <Paragraph variant="small/bright" className="text-warning">
                Active incident
              </Paragraph>
            </div>

            {/* Description */}
            <Paragraph variant="extra-small/bright" className="text-warning/80">
              Our team is working on resolving the issue. Check our status page for more
              information.
            </Paragraph>

            {/* Button */}
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
        </motion.div>

        {/* Collapsed button - animated height and opacity */}
        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? "auto" : 0,
            opacity: isCollapsed ? 1 : 0,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <SimpleTooltip
            button={
              <PopoverTrigger className="flex !h-8 w-full items-center justify-center rounded border border-warning/20 bg-warning/10 transition-colors hover:border-warning/30 hover:bg-warning/20">
                <ExclamationTriangleIcon className="size-5 text-warning" />
              </PopoverTrigger>
            }
            content="Active incident"
            side="right"
            sideOffset={8}
            disableHoverableContent
            asChild
          />
        </motion.div>
      </div>
      <PopoverContent side="right" sideOffset={8} align="start" className="!min-w-0 w-52 p-0">
        <IncidentPopoverContent />
      </PopoverContent>
    </Popover>
  );
}

function IncidentPopoverContent() {
  return (
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
  );
}
