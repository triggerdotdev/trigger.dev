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
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentProject } from "~/hooks/useProject";
import { projectEnvironmentsPath, projectPath } from "~/utils/pathBuilder";

export const handle = {
  useBreadcrumbElement: () => {
    const organization = useCurrentOrganization();
    invariant(organization, "Organization must be defined");
    const project = useCurrentProject();
    invariant(project, "Project must be defined");

    return (
      <BreadcrumbLink
        to={projectEnvironmentsPath(organization, project)}
        title="Environments"
      />
    );
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
