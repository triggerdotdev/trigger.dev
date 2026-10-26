import { BellAlertIcon } from "@heroicons/react/20/solid";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import {
  watchBlockedReasons,
  watchQueryChoice,
  watchQueryHref,
} from "~/components/alerts/queryAlertLink";
import { useDashboardAgent } from "~/components/dashboard-agent/dashboardAgentLauncher";
import type { QueryAlertAnalysis } from "~/v3/services/alerts/queryAlerts/analyzeQueryForAlert.server";

export type WatchQueryAnalysis = { query: string; analysis: QueryAlertAnalysis | null };

export function WatchQueryButton({
  alertsPath,
  period,
  watch,
}: {
  alertsPath: string;
  period: string;
  watch: WatchQueryAnalysis | null | undefined;
}) {
  const agent = useDashboardAgent();
  const analysis = watch?.analysis;
  if (!watch || !analysis?.ok || watchBlockedReasons(analysis, watch.query).length > 0) {
    return null;
  }
  return (
    <span data-testid="watch-query">
      {agent ? (
        <Button
          type="button"
          variant="secondary/small"
          LeadingIcon={BellAlertIcon}
          leadingIconClassName="text-alerts"
          onClick={() =>
            agent.openCreateAlert({
              source: "query",
              query: watch.query,
              period,
              ...watchQueryChoice(analysis),
            })
          }
        >
          Watch
        </Button>
      ) : (
        <LinkButton
          variant="secondary/small"
          to={watchQueryHref(alertsPath, watch.query, period, analysis)}
          LeadingIcon={BellAlertIcon}
          leadingIconClassName="text-alerts"
        >
          Watch
        </LinkButton>
      )}
    </span>
  );
}
