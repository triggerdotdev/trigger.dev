import { BellAlertIcon } from "@heroicons/react/20/solid";
import { Button, ButtonContent, LinkButton } from "~/components/primitives/Buttons";
import {
  watchBlockedReasons,
  watchQueryChoice,
  watchQueryHref,
} from "~/components/alerts/queryAlertLink";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
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
  if (!watch || !analysis) return null;
  const [reason] = watchBlockedReasons(analysis, watch.query);
  if (reason) {
    return (
      <span data-testid="watch-query">
        <SimpleTooltip
          asChild
          tabbable
          button={
            <button
              type="button"
              aria-disabled="true"
              aria-describedby="watch-query-reason"
              className="group/button cursor-default opacity-60 outline-hidden focus-custom"
              onClick={(e) => e.preventDefault()}
            >
              <ButtonContent
                variant="secondary/small"
                LeadingIcon={BellAlertIcon}
                leadingIconClassName="text-alerts"
              >
                Watch
              </ButtonContent>
            </button>
          }
          content={reason}
        />
        <span id="watch-query-reason" className="sr-only">
          {reason}
        </span>
      </span>
    );
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
