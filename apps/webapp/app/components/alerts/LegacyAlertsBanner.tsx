import { AnimatedOrgBannerBar } from "~/components/billing/AnimatedOrgBannerBar";
import { LinkButton } from "~/components/primitives/Buttons";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { v3ProjectLegacyAlertsPath } from "~/utils/pathBuilder";

export function LegacyAlertsBanner({ show }: { show: boolean }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <AnimatedOrgBannerBar
      show={show}
      variant="warning"
      action={
        <LinkButton
          to={v3ProjectLegacyAlertsPath(organization, project, environment)}
          variant="secondary/small"
        >
          View legacy alerts
        </LinkButton>
      }
    >
      You have legacy alerts. The new Alerts replace them — review and migrate.
    </AnimatedOrgBannerBar>
  );
}
