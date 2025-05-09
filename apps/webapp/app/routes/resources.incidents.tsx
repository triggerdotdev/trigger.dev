import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { json } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import { useCallback, useEffect } from "react";
import { motion } from "framer-motion";
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
    operational: result.data.attributes.aggregate_state === "operational",
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
  }, []);

  const operational = fetcher.data?.operational ?? true;

  return (
    <>
      {!operational && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="p-1"
        >
          <div className="flex flex-col gap-2 rounded border border-warning/20 bg-warning/5 p-2 pt-1.5">
            <div className="flex items-center gap-1 border-b border-warning/20 pb-1 text-warning">
              <ExclamationTriangleIcon className="size-4" />
              <Paragraph variant="small/bright" className="text-warning">
                Active incident
              </Paragraph>
            </div>
            <Paragraph variant="extra-small/bright" className="text-warning/80">
              Our team is working on resolving the issue. Check our status page for more
              information.
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
        </motion.div>
      )}
    </>
  );
}
