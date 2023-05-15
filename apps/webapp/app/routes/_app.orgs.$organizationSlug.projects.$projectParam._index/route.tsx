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
import { projectPath } from "~/utils/pathBuilder";

export const handle = {
  breadcrumb: () => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const organization = useCurrentOrganization();
    invariant(organization, "Organization must be defined");
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const project = useCurrentProject();
    invariant(project, "Project must be defined");

    return (
      <BreadcrumbLink to={projectPath(organization, project)} title="Jobs" />
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
          <PageTitle title="Jobs" />
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
        <PageDescription>XX active Jobs</PageDescription>
      </PageHeader>
    </PageContainer>
  );
}
