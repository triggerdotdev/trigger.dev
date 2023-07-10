import { Outlet } from "@remix-run/react";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  PageDescription,
  PageHeader,
  PageTabs,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";
import {
  projectScheduledTriggersPath,
  projectTriggersPath,
} from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: {
    slug: "triggers",
  },
};

export default function Integrations() {
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Triggers" />
        </PageTitleRow>
        <PageDescription>
          Triggers are attached to Jobs, and cause them to run
        </PageDescription>
        <PageTabs
          tabs={[
            {
              label: "External",
              to: projectTriggersPath(organization, project),
            },
            // {
            //   label: "Scheduled",
            //   to: projectScheduledTriggersPath(organization, project),
            // },
          ]}
        />
      </PageHeader>

      <PageBody scrollable={false}>
        <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <Outlet />
        </div>
      </PageBody>
    </PageContainer>
  );
}
