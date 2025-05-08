import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { json } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import { useCallback, useEffect } from "react";
import { LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useFeatures } from "~/hooks/useFeatures";
import { BetterStackClient } from "~/services/betterstack/betterstack.server";

export async function loader() {
  const client = new BetterStackClient();
  const result = await client.getIncidents();

  if (!result.success) {
    return json({ operational: true });
  }

  return json({
    operational: result.data.data.attributes.aggregate_state === "operational",
  });
}

export function IncidentStatusPanel() {
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
  }, [fetchIncidents]);

  const operational = fetcher.data?.operational ?? true;

  return (
    <>
      {!operational && (
        <div className="p-1">
          <div className="flex flex-col gap-2 rounded border border-warning/20 bg-warning/5 p-2 pt-1.5">
            <div className="flex items-center gap-1 border-b border-warning/20 pb-1 text-warning">
              <ExclamationTriangleIcon className="size-4" />
              <Paragraph variant="small/bright" className="text-warning">
                Active Incident
              </Paragraph>
            </div>
            <Paragraph variant="extra-small/bright" className="line-clamp-3 text-warning/80">
              We're currently experiencing service disruptions. Our team is actively working on
              resolving the issue. Check our status page for real-time updates.
            </Paragraph>
            <LinkButton
              variant="secondary/small"
              to="https://status.trigger.dev"
              target="_blank"
              fullWidth
            >
              View Status Page
            </LinkButton>
          </div>
        </div>
      )}
    </>
  );
}
