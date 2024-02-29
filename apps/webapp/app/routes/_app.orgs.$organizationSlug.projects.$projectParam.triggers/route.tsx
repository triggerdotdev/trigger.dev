import { Outlet } from "@remix-run/react";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { PageAccessories, NavBar, PageTabs, PageTitle } from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  docsPath,
  projectScheduledTriggersPath,
  projectTriggersPath,
  projectWebhookTriggersPath,
} from "~/utils/pathBuilder";

export default function Page() {
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Triggers" />
        <PageAccessories>
          <LinkButton
            LeadingIcon={"docs"}
            to={docsPath("documentation/concepts/triggers")}
            variant="secondary/small"
          >
            Triggers documentation
          </LinkButton>
        </PageAccessories>

        <PageTabs
          layoutId="triggers"
          tabs={[
            {
              label: "External Triggers",
              to: projectTriggersPath(organization, project),
            },
            {
              label: "Scheduled Triggers",
              to: projectScheduledTriggersPath(organization, project),
            },
            {
              label: "Webhook Triggers",
              to: projectWebhookTriggersPath(organization, project),
            },
          ]}
        />
      </NavBar>

      <PageBody scrollable={false}>
        <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <Outlet />
        </div>
      </PageBody>
    </PageContainer>
  );
}
