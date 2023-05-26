import invariant from "tiny-invariant";
import { PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import { useCurrentProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";
import { projectEnvironmentsPath, projectPath } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: {
    slug: "environments",
  },
};

export default function Page() {
  const currentProject = useCurrentProject();
  invariant(currentProject, "Project must be defined");

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Environments" />
          <PageButtons>
            {/* <LinkButton
              to={newProjectPath(currentOrganization)}
              variant="primary/small"
              shortcut="N"
            >
              Create a new project
            </LinkButton> */}
          </PageButtons>
        </PageTitleRow>
        {/* <PageDescription>XX active Jobs</PageDescription> */}
      </PageHeader>
    </PageContainer>
  );
}
