import { BookOpenIcon } from "@heroicons/react/20/solid";
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
            LeadingIcon={BookOpenIcon}
            to={docsPath("documentation/concepts/triggers")}
            variant="minimal/small"
          >
            Triggers documentation
          </LinkButton>
        </PageAccessories>
      </NavBar>

      <PageBody scrollable={false}>
        <div className="grid max-h-full grid-rows-[auto_1fr] overflow-hidden px-4">
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
          <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <Outlet />
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
