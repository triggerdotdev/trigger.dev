import invariant from "tiny-invariant";
import { PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentProject } from "~/hooks/useProject";
import { newProjectPath } from "~/utils/pathBuilder";

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
        <PageDescription>
          Create new Organizations and new Projects to help organize your Jobs.
        </PageDescription>
      </PageHeader>
    </PageContainer>
  );
}
