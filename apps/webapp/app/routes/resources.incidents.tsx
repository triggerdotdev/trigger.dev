import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { json } from "@remix-run/node";
import { useFetcher, type ShouldRevalidateFunction } from "@remix-run/react";
import { motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useFeatures } from "~/hooks/useFeatures";
import { BetterStackClient, type AggregateState } from "~/services/betterstack/betterstack.server";

// Prevent Remix from revalidating this route when other fetchers submit
export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export type IncidentLoaderData = {
  status: AggregateState;
  title: string | null;
};

export async function loader() {
  const client = new BetterStackClient();
  const result = await client.getIncidentStatus();

  if (!result.success) {
    return json<IncidentLoaderData>({ status: "operational", title: null });
  }

  return json<IncidentLoaderData>({
    status: result.data.status,
    title: result.data.title,
  });
}

const DEFAULT_MESSAGE =
  "Our team is working on resolving the issue. Check our status page for more information.";

const POLL_INTERVAL_MS = 60_000;

/** Hook to fetch and poll incident status */
export function useIncidentStatus() {
  const { isManagedCloud } = useFeatures();
  const fetcher = useFetcher<typeof loader>();
  const hasInitiallyFetched = useRef(false);

  useEffect(() => {
    if (!isManagedCloud) return;

    // Initial fetch on mount
    if (!hasInitiallyFetched.current && fetcher.state === "idle") {
      hasInitiallyFetched.current = true;
      fetcher.load("/resources/incidents");
    }

    // Poll every 60 seconds
    const interval = setInterval(() => {
      if (fetcher.state === "idle") {
        fetcher.load("/resources/incidents");
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isManagedCloud]);

  return {
    status: fetcher.data?.status ?? "operational",
    title: fetcher.data?.title ?? null,
    hasIncident: (fetcher.data?.status ?? "operational") !== "operational",
    isManagedCloud,
  };
}

export function IncidentStatusPanel({
  isCollapsed = false,
  title,
  hasIncident,
  isManagedCloud,
}: {
  isCollapsed?: boolean;
  title: string | null;
  hasIncident: boolean;
  isManagedCloud: boolean;
}) {
  if (!isManagedCloud || !hasIncident) {
    return null;
  }

  const message = title || DEFAULT_MESSAGE;

  return (
    <Popover>
      <div className="p-1">
        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? 0 : "auto",
            opacity: isCollapsed ? 0 : 1,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <IncidentPanelContent message={message} />
        </motion.div>

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
              <PopoverTrigger className="flex !h-8 w-full items-center justify-center rounded border border-yellow-500/30 bg-yellow-500/15 transition-colors hover:border-yellow-500/50 hover:bg-yellow-500/25">
                <ExclamationTriangleIcon className="size-5 text-yellow-400" />
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
        <IncidentPanelContent message={message} />
      </PopoverContent>
    </Popover>
  );
}

function IncidentPanelContent({ message }: { message: string }) {
  return (
    <div className="flex flex-col gap-2 rounded border border-yellow-500/30 bg-yellow-500/10 p-2 pt-1.5">
      <div className="flex items-center gap-1 border-b border-yellow-500/30 pb-1">
        <ExclamationTriangleIcon className="size-4 text-yellow-400" />
        <Paragraph variant="small/bright" className="text-yellow-300">
          Active incident
        </Paragraph>
      </div>
      <Paragraph variant="extra-small/bright" className="text-yellow-300">
        {message}
      </Paragraph>
      <LinkButton
        variant="secondary/small"
        to="https://status.trigger.dev"
        target="_blank"
        fullWidth
        className="border-yellow-500/30 bg-yellow-500/15 hover:!border-yellow-500/50 hover:!bg-yellow-500/25"
      >
        <span className="text-yellow-300">View status page</span>
      </LinkButton>
    </div>
  );
}
